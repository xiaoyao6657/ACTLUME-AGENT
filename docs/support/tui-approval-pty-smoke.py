#!/usr/bin/env python3
"""Drive one Actlume TUI approval through a local deterministic OpenAI mock.

This validates that the approval dialog receives a keyboard denial and that
the requested harmless shell command is not executed. It is not a human
visual, OS IME, or Windows Terminal test.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


TOOL_NAME = "shell"
COMMAND = "echo ACTLUME_APPROVAL_SMOKE_EXECUTED"
PROMPT = "Run the shell tool with the exact command echo ACTLUME_APPROVAL_SMOKE_EXECUTED. Do not run anything else."


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True, type=Path, help="Linux/ext4 checkout of Actlume")
    parser.add_argument("--output-dir", required=True, type=Path, help="Directory for the raw PTY transcript and JSON report")
    parser.add_argument("--node", default=shutil.which("node"), help="Node executable (default: node on PATH)")
    parser.add_argument("--expected-candidate", help="Require this worktree-manifest SHA-256 before running")
    parser.add_argument("--path-prefix", action="append", default=[], help="Extra directory prepended to the child PATH; repeatable")
    parser.add_argument("--startup-timeout", type=float, default=15.0)
    parser.add_argument("--approval-timeout", type=float, default=25.0)
    parser.add_argument("--exit-timeout", type=float, default=8.0)
    return parser.parse_args()


def sse_chunk(response: BaseHTTPRequestHandler, request_id: str, delta: dict[str, Any], finish: str | None) -> None:
    chunk = {
        "id": request_id,
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "actlume-tui-approval-mock",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    response.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
    response.wfile.flush()


def write_stream(response: BaseHTTPRequestHandler, tool_call: bool) -> None:
    response.send_response(200)
    response.send_header("Content-Type", "text/event-stream")
    response.send_header("Cache-Control", "no-cache")
    response.send_header("Connection", "close")
    response.end_headers()
    request_id = "actlume-tui-approval-smoke"
    sse_chunk(response, request_id, {"role": "assistant"}, None)
    if tool_call:
        args = json.dumps({"command": COMMAND}, separators=(",", ":"))
        sse_chunk(response, request_id, {
            "tool_calls": [{
                "index": 0,
                "id": "approval-smoke-call",
                "type": "function",
                "function": {"name": TOOL_NAME, "arguments": args},
            }],
        }, None)
        sse_chunk(response, request_id, {}, "tool_calls")
    else:
        sse_chunk(response, request_id, {"content": "The approval decision was handled."}, None)
        sse_chunk(response, request_id, {}, "stop")
    usage = {"id": request_id, "object": "chat.completion.chunk", "created": 1,
             "model": "actlume-tui-approval-mock", "choices": [],
             "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20}}
    response.wfile.write(f"data: {json.dumps(usage)}\n\n".encode())
    response.wfile.write(b"data: [DONE]\n\n")
    response.wfile.flush()


def read_output(fd: int, duration: float) -> bytes:
    deadline = time.monotonic() + duration
    chunks: list[bytes] = []
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], min(0.15, max(0, deadline - time.monotonic())))
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)


def wait_for_exit(pid: int, fd: int, timeout: float, output: bytearray) -> tuple[int | None, int | None]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        waited_pid, status = os.waitpid(pid, os.WNOHANG)
        if waited_pid == pid:
            output.extend(read_output(fd, 0.2))
            return os.waitstatus_to_exitcode(status), status
        output.extend(read_output(fd, 0.15))
    return None, None


def main() -> int:
    if os.name != "posix":
        raise SystemExit("This PTY driver requires Linux or another POSIX system; Windows approval-focus checks are manual.")
    args = parse_args()
    if not args.node:
        raise SystemExit("Node was not found; pass --node /absolute/path/to/node.")
    node = str(Path(args.node).resolve())
    workspace = args.workspace.resolve(strict=True)
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    path_parts = [str(Path(prefix).resolve()) for prefix in args.path_prefix]
    path_parts.extend([str(Path(node).parent), "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"])

    manifest = json.loads(subprocess.check_output([node, "scripts/worktree-manifest.mjs"], cwd=workspace, text=True))
    if args.expected_candidate and manifest["candidateSha256"] != args.expected_candidate:
        raise SystemExit(f"Candidate mismatch: expected {args.expected_candidate}, got {manifest['candidateSha256']}")

    provider_state: dict[str, Any] = {"requests": [], "errors": []}
    provider_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            tools = body.get("tools", [])
            tool_names = [tool.get("function", {}).get("name") for tool in tools]
            messages = body.get("messages", [])
            tool_messages = [message for message in messages if message.get("role") == "tool"]
            with provider_lock:
                provider_state["requests"].append({
                    "toolNames": tool_names,
                    "messageRoles": [message.get("role") for message in messages],
                    "toolReply": [str(message.get("content", "")) for message in tool_messages],
                })
                request_index = len(provider_state["requests"])
            try:
                if request_index == 1:
                    if TOOL_NAME not in tool_names:
                        raise RuntimeError(f"Pi did not expose expected tool {TOOL_NAME!r}: {tool_names}")
                    write_stream(self, tool_call=True)
                else:
                    write_stream(self, tool_call=False)
            except Exception as error:
                with provider_lock:
                    provider_state["errors"].append(f"{type(error).__name__}: {error}")
                if not self.wfile.closed:
                    self.send_error(500)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}/v1"

    with tempfile.TemporaryDirectory(prefix="actlume-tui-approval-") as temp_home:
        child_env = os.environ.copy()
        child_env.update({
            "PATH": os.pathsep.join(path_parts),
            "HOME": temp_home,
            "ACTLUME_HOME": temp_home,
            "AGENT_MEMORY_DIR": str(Path(temp_home) / "memory"),
            "AGENT_WORKSPACE": str(workspace),
            "OPENAI_API_KEY": "local-tui-approval-smoke",
            "OPENAI_BASE_URL": base_url,
            "OPENAI_MODEL": "gpt-4.1-mini",
            "AGENT_PERMISSION_MODE": "default",
            "AGENT_READONLY": "false",
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
        })
        pid, master = pty.fork()
        if pid == 0:
            os.chdir(workspace)
            os.execvpe(node, [node, "--import", "tsx", "src/main.ts"], child_env)

        transcript = bytearray()
        exit_code: int | None = None
        wait_status: int | None = None
        startup_bytes = 0
        approval_prompt_seen = False
        denial_key_sent = False
        final_response_seen = False
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            transcript.extend(read_output(master, args.startup_timeout))
            startup_bytes = len(transcript)
            if startup_bytes:
                paste = f"\x1b[200~{PROMPT}\x1b[201~".encode("utf-8")
                os.write(master, paste)
                transcript.extend(read_output(master, 0.3))
                os.write(master, b"\r")
                deadline = time.monotonic() + args.approval_timeout
                while time.monotonic() < deadline:
                    transcript.extend(read_output(master, 0.25))
                    screen_text = transcript.decode("utf-8", errors="replace")
                    if "Actlume permission required" in screen_text:
                        approval_prompt_seen = True
                        break
                if approval_prompt_seen:
                    # Pi renders a focused Yes/No list; move to No and confirm.
                    os.write(master, b"\x1b[B")
                    transcript.extend(read_output(master, 0.25))
                    os.write(master, b"\r")
                    denial_key_sent = True
                    deadline = time.monotonic() + args.approval_timeout
                    while time.monotonic() < deadline:
                        transcript.extend(read_output(master, 0.25))
                        with provider_lock:
                            response_count = len(provider_state["requests"])
                        if response_count >= 2:
                            final_response_seen = True
                            break
            os.write(master, b"\x04")
            exit_code, wait_status = wait_for_exit(pid, master, args.exit_timeout, transcript)
        finally:
            if exit_code is None:
                try:
                    os.killpg(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    waited_pid, wait_status = os.waitpid(pid, 0)
                    if waited_pid == pid:
                        exit_code = os.waitstatus_to_exitcode(wait_status)
                except ChildProcessError:
                    pass
            os.close(master)
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2.0)

    raw = bytes(transcript)
    with provider_lock:
        requests = list(provider_state["requests"])
        errors = list(provider_state["errors"])
    replies = [reply for request in requests for reply in request["toolReply"]]
    denial_in_tool_reply = any("User rejected shell" in reply for reply in replies)
    command_output_in_tool_reply = any("ACTLUME_APPROVAL_SMOKE_EXECUTED" in reply for reply in replies)
    report = {
        "schemaVersion": 1,
        "dataClass": "automated-pty-approval-smoke-only",
        "qualityClaim": False,
        "candidateSha256": manifest["candidateSha256"],
        "changedProductionInputs": manifest["changedProductionInputs"],
        "platform": sys.platform,
        "node": subprocess.check_output([node, "--version"], text=True).strip(),
        "pi": json.loads((workspace / "node_modules/@earendil-works/pi-coding-agent/package.json").read_text())["version"],
        "provider": "in-process local deterministic OpenAI-compatible server",
        "baseURL": base_url,
        "startupOutputBytes": startup_bytes,
        "providerRequestCount": len(requests),
        "providerRequests": requests,
        "providerErrors": errors,
        "approvalPromptSeen": approval_prompt_seen,
        "denialKeySent": denial_key_sent,
        "finalModelResponseSeen": final_response_seen,
        "denialRecordedInToolReply": denial_in_tool_reply,
        "commandOutputAppearedInToolReply": command_output_in_tool_reply,
        "exitCode": exit_code,
        "waitStatus": wait_status,
        "rawTranscriptSha256": hashlib.sha256(raw).hexdigest(),
        "limitations": "Automated Linux PTY and deterministic-provider check only. It verifies keyboard denial reaches the approval flow and the harmless command is not run; it does not verify OS IME composition, human visual rendering, Windows approval focus, long-history navigation, or a screen recording.",
    }
    transcript_path = output_dir / "tui-approval-smoke.typescript"
    report_path = output_dir / "tui-approval-smoke.json"
    transcript_path.write_bytes(raw)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(report_path), "transcript": str(transcript_path), **report}, ensure_ascii=False))

    passed = (
        startup_bytes > 0
        and approval_prompt_seen
        and denial_key_sent
        and final_response_seen
        and denial_in_tool_reply
        and not command_output_in_tool_reply
        and exit_code == 0
        and not errors
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
