#!/usr/bin/env python3
"""Automated Linux PTY smoke for Actlume's Pi-backed interactive terminal.

This checks process startup, bracketed Unicode paste, PTY resizing, Ctrl+C,
Ctrl+D, and basic termios restoration. It does not simulate an OS IME or
replace human visual/interaction checks.
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
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True, type=Path, help="Linux/ext4 checkout of Actlume")
    parser.add_argument("--output-dir", required=True, type=Path, help="Directory for the raw PTY transcript and JSON report")
    parser.add_argument("--node", default=shutil.which("node"), help="Node executable (default: node on PATH)")
    parser.add_argument("--expected-candidate", help="Require this worktree-manifest SHA-256 before running")
    parser.add_argument("--path-prefix", action="append", default=[], help="Extra directory prepended to the child PATH; repeatable")
    parser.add_argument("--startup-timeout", type=float, default=15.0)
    parser.add_argument("--exit-timeout", type=float, default=8.0)
    return parser.parse_args()


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


def pty_size(fd: int) -> tuple[int, int]:
    rows, columns, _, _ = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
    return rows, columns


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
        raise SystemExit("This PTY driver requires Linux or another POSIX system; Windows IME/rendering checks are manual.")
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
        raise SystemExit(
            f"Candidate mismatch: expected {args.expected_candidate}, got {manifest['candidateSha256']}"
        )

    with tempfile.TemporaryDirectory(prefix="actlume-tui-pty-") as temp_home:
        child_env = os.environ.copy()
        child_env.update({
            "PATH": os.pathsep.join(path_parts),
            "HOME": temp_home,
            "ACTLUME_HOME": temp_home,
            "AGENT_MEMORY_DIR": str(Path(temp_home) / "memory"),
            "AGENT_WORKSPACE": str(workspace),
            "OPENAI_API_KEY": "tui-smoke-no-request",
            "OPENAI_BASE_URL": "http://127.0.0.1:9/v1",
            "OPENAI_MODEL": "gpt-4.1-mini",
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
        resized_size: tuple[int, int] | None = None
        ctrl_c_sent = False
        ctrl_d_sent = False
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            transcript.extend(read_output(master, args.startup_timeout))
            startup_bytes = len(transcript)
            if startup_bytes:
                paste = "\x1b[200~中文输入 🎛️\n第二行 paste-smoke\x1b[201~".encode("utf-8")
                os.write(master, paste)
                transcript.extend(read_output(master, 1.0))
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
                resized_size = pty_size(master)
                transcript.extend(read_output(master, 1.0))
                os.write(master, b"\x03")
                ctrl_c_sent = True
                transcript.extend(read_output(master, 0.7))
                os.write(master, b"\x04")
                ctrl_d_sent = True
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
            try:
                termios_after_exit = termios.tcgetattr(master)[3]
                modes_after_exit: dict[str, bool] | None = {
                    "canonicalInput": bool(termios_after_exit & termios.ICANON),
                    "echo": bool(termios_after_exit & termios.ECHO),
                    "signals": bool(termios_after_exit & termios.ISIG),
                }
                modes_restored: bool | None = all(modes_after_exit.values())
            except OSError:
                modes_after_exit = None
                modes_restored = None
            os.close(master)

    raw = bytes(transcript)
    decoded = raw.decode("utf-8", errors="replace")
    unicode_visible = "中文输入" in decoded and "第二行" in decoded
    resized_to_120x40 = resized_size == (40, 120)
    report = {
        "schemaVersion": 1,
        "dataClass": "automated-pty-smoke-only",
        "qualityClaim": False,
        "candidateSha256": manifest["candidateSha256"],
        "changedProductionInputs": manifest["changedProductionInputs"],
        "platform": sys.platform,
        "node": subprocess.check_output([node, "--version"], text=True).strip(),
        "pi": json.loads((workspace / "node_modules/@earendil-works/pi-coding-agent/package.json").read_text())["version"],
        "initialPtySize": "80x24",
        "resizedPtySize": f"{resized_size[1]}x{resized_size[0]}" if resized_size else None,
        "startupOutputBytes": startup_bytes,
        "totalOutputBytes": len(raw),
        "bracketedUnicodeMultilinePasteVisibleInRedraw": unicode_visible,
        "ctrlCSent": ctrl_c_sent,
        "ctrlDSent": ctrl_d_sent,
        "exitCode": exit_code,
        "waitStatus": wait_status,
        "terminalModesAfterExit": modes_after_exit,
        "canonicalEchoSignalModesRestored": modes_restored,
        "rawTranscriptSha256": hashlib.sha256(raw).hexdigest(),
        "manualMatrix": {
            "osImeComposition": False,
            "approvalFocus": False,
            "longHistoryScrolling": False,
            "visualReview": False,
            "screenRecording": False,
        },
        "limitations": "Automated PTY input/resize smoke only. It does not verify OS IME composition, human visual rendering, approval focus, long-history navigation, or a screen recording.",
    }
    transcript_path = output_dir / "tui-pty-smoke.typescript"
    report_path = output_dir / "tui-pty-smoke.json"
    transcript_path.write_bytes(raw)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(report_path), "transcript": str(transcript_path), **report}, ensure_ascii=False))

    passed = (
        startup_bytes > 0
        and unicode_visible
        and resized_to_120x40
        and ctrl_c_sent
        and ctrl_d_sent
        and exit_code == 0
        and modes_restored is True
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
