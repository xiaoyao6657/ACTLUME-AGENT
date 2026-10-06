#!/usr/bin/env python3
"""Serve a loopback-only deterministic provider for human Actlume TUI checks.

The server never launches or controls Actlume and never connects to an upstream
provider. Start it in one terminal, then launch the TUI yourself in another.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


MODEL_ID = "gpt-4.1-mini"
APPROVAL_COMMAND = "echo ACTLUME_MANUAL_APPROVAL_MARKER"
LONG_OUTPUT_COMMAND = (
    'node -e "for (let i=0; i<80; i++) console.log(\'ACTLUME_MANUAL_TOOL_OUTPUT_\'+i)"'
)


class LoopbackHTTPServer(ThreadingHTTPServer):
    def handle_error(self, _request: Any, _client_address: Any) -> None:
        error = sys.exc_info()[1]
        if isinstance(error, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            print("client disconnected from the local mock", flush=True)
            return
        super().handle_error(_request, _client_address)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765, help="Loopback port (default: 8765)")
    parser.add_argument(
        "--scenario",
        choices=("approval", "long-output"),
        default="approval",
        help="Harmless shell tool call to offer for each new user turn",
    )
    parser.add_argument(
        "--delay-first-seconds",
        type=float,
        default=0,
        help="Delay the first response to exercise TUI cancellation/queued input",
    )
    parser.add_argument("--self-test", action="store_true", help="Check both SSE scenarios and exit")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    if args.delay_first_seconds < 0 or args.delay_first_seconds > 300:
        parser.error("--delay-first-seconds must be between 0 and 300")
    return args


def tool_command(scenario: str) -> str:
    return LONG_OUTPUT_COMMAND if scenario == "long-output" else APPROVAL_COMMAND


def make_server(scenario: str, delay_first_seconds: float, port: int = 0) -> ThreadingHTTPServer:
    lock = threading.Lock()
    state = {"requestCount": 0}

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path == "/healthz":
                self.send_json(200, {"status": "ok", "provider": "actlume-local-manual"})
                return
            if self.path in ("/models", "/v1/models"):
                self.send_json(200, {
                    "object": "list",
                    "data": [{"id": MODEL_ID, "object": "model", "created": 1, "owned_by": "actlume-local"}],
                })
                return
            self.send_json(404, {"error": {"message": "Not found"}})

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if not self.path.endswith("/chat/completions"):
                self.send_json(404, {"error": {"message": "Not found"}})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 2_000_000:
                    self.send_json(413, {"error": {"message": "Invalid request size"}})
                    return
                body = json.loads(self.rfile.read(length))
                messages = body.get("messages", [])
                tools = body.get("tools", [])
                if not isinstance(messages, list) or not isinstance(tools, list):
                    self.send_json(400, {"error": {"message": "Invalid messages or tools"}})
                    return
                last_user = max((i for i, item in enumerate(messages) if item.get("role") == "user"), default=-1)
                last_tool = max((i for i, item in enumerate(messages) if item.get("role") == "tool"), default=-1)
                offer_tool = last_user > last_tool
                shell_available = any(
                    isinstance(item, dict)
                    and item.get("function", {}).get("name") == "shell"
                    for item in tools
                )
                offer_tool = offer_tool and shell_available
                with lock:
                    state["requestCount"] += 1
                    request_number = state["requestCount"]
                if request_number == 1 and delay_first_seconds:
                    time.sleep(delay_first_seconds)
                self.write_completion(
                    request_number=request_number,
                    model=str(body.get("model") or MODEL_ID),
                    offer_tool=offer_tool,
                    messages=messages,
                )
                print(
                    f"request={request_number} action={'tool_call' if offer_tool else 'final_response'} "
                    f"scenario={scenario} (request content omitted)",
                    flush=True,
                )
            except (BrokenPipeError, ConnectionResetError):
                print("client disconnected before the mock response completed", flush=True)
            except (ValueError, json.JSONDecodeError) as error:
                try:
                    self.send_json(400, {"error": {"message": f"Invalid JSON: {type(error).__name__}"}})
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def write_completion(
            self,
            *,
            request_number: int,
            model: str,
            offer_tool: bool,
            messages: list[dict[str, Any]],
        ) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            request_id = f"actlume-manual-{request_number}"
            self.sse_chunk(request_id, model, {"role": "assistant"}, None)
            if offer_tool:
                args = json.dumps({"command": tool_command(scenario)}, separators=(",", ":"))
                self.sse_chunk(request_id, model, {
                    "tool_calls": [{
                        "index": 0,
                        "id": f"actlume-manual-call-{request_number}",
                        "type": "function",
                        "function": {"name": "shell", "arguments": args},
                    }],
                }, None)
                self.sse_chunk(request_id, model, {}, "tool_calls")
            else:
                tool_replies = [
                    str(item.get("content", ""))
                    for item in messages
                    if item.get("role") == "tool"
                ]
                if any("User rejected shell" in reply for reply in tool_replies):
                    answer = "The local mock received the denial; no command was executed."
                elif any("ACTLUME_MANUAL_TOOL_OUTPUT_" in reply for reply in tool_replies):
                    answer = "The local mock received the harmless long-output demo result."
                elif any("ACTLUME_MANUAL_APPROVAL_MARKER" in reply for reply in tool_replies):
                    answer = "The local mock received the harmless approval demo result."
                else:
                    answer = "The local mock completed this turn without a shell tool."
                self.sse_chunk(request_id, model, {"content": answer}, None)
                self.sse_chunk(request_id, model, {}, "stop")
            usage = {
                "id": request_id,
                "object": "chat.completion.chunk",
                "created": 1,
                "model": model,
                "choices": [],
                "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
            }
            self.wfile.write(f"data: {json.dumps(usage)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

        def sse_chunk(self, request_id: str, model: str, delta: dict[str, Any], finish: str | None) -> None:
            chunk = {
                "id": request_id,
                "object": "chat.completion.chunk",
                "created": 1,
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()

        def send_json(self, status: int, value: dict[str, Any]) -> None:
            payload = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return LoopbackHTTPServer(("127.0.0.1", port), Handler)


def read_sse(response: Any) -> list[dict[str, Any]]:
    chunks = []
    for raw_line in response:
        line = raw_line.decode("utf-8").strip()
        if line.startswith("data: ") and line != "data: [DONE]":
            chunks.append(json.loads(line[6:]))
    return chunks


def self_test() -> None:
    for scenario in ("approval", "long-output"):
        server = make_server(scenario, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_port}/v1"
        try:
            first = {
                "model": MODEL_ID,
                "stream": True,
                "messages": [{"role": "system", "content": "test"}, {"role": "user", "content": "test"}],
                "tools": [{"type": "function", "function": {"name": "shell", "parameters": {}}}],
            }
            req = urllib.request.Request(
                f"{base_url}/chat/completions",
                data=json.dumps(first).encode(),
                headers={"Content-Type": "application/json", "Authorization": "Bearer local-only"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                chunks = read_sse(response)
            calls = [
                call
                for chunk in chunks
                for choice in chunk.get("choices", [])
                for call in choice.get("delta", {}).get("tool_calls", [])
            ]
            if len(calls) != 1 or calls[0].get("function", {}).get("name") != "shell":
                raise RuntimeError(f"{scenario}: missing deterministic shell tool call")
            command = json.loads(calls[0]["function"]["arguments"])["command"]
            expected_marker = "ACTLUME_MANUAL_TOOL_OUTPUT_" if scenario == "long-output" else "ACTLUME_MANUAL_APPROVAL_MARKER"
            if expected_marker not in command:
                raise RuntimeError(f"{scenario}: unexpected demo command")
            followup = {
                **first,
                "messages": first["messages"] + [
                    {"role": "assistant", "content": None, "tool_calls": calls},
                    {"role": "tool", "tool_call_id": calls[0]["id"], "content": "User rejected shell."},
                ],
            }
            req = urllib.request.Request(
                f"{base_url}/chat/completions",
                data=json.dumps(followup).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                chunks = read_sse(response)
            content = "".join(
                choice.get("delta", {}).get("content", "")
                for chunk in chunks
                for choice in chunk.get("choices", [])
            )
            if "no command was executed" not in content:
                raise RuntimeError(f"{scenario}: denial result was not reported")
            print(f"PASS {scenario}: local SSE tool offer and denial follow-up")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


def main() -> int:
    args = parse_args()
    if args.self_test:
        self_test()
        return 0
    server = make_server(args.scenario, args.delay_first_seconds, args.port)
    print(
        f"Local-only mock provider: http://127.0.0.1:{server.server_port}/v1 "
        f"scenario={args.scenario} delayFirst={args.delay_first_seconds}s; no upstream calls. Press Ctrl+C to stop.",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping local mock provider.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
