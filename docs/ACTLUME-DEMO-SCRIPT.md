# Actlume deterministic recovery demo

This walkthrough demonstrates a real runtime interruption and same-task recovery. It uses a scripted local provider and is not a model-quality result.

Run from the repository root:

```powershell
npm run eval:protocol-smoke -- --task interrupt-recovery-01
```

The runner creates an isolated parser fixture and empty MCP configuration, runs the planned edit in a separate worker process, waits until `writeFile` has completed, and forcibly terminates the worker/Pi process tree before verification. It then reopens the same Pi session, checks the current workspace state, runs the fixture's required `npm test`, and evaluates the result outside the agent workspace.

The expected terminal summary has `protocolValidated: true`, final runtime `completed`, evidence `checks_passed`, and oracle `pass`. The JSON report under `.agent-benchmark/protocol-runs/` should record phase 1 as `interrupted/unknown`, phase 2 as `completed/checks_passed`, the same session and task, `runtimeTerminated: true`, `duplicateEdits: 0`, and `checkPassed: true`.

The latest source candidate `sha256:1897300da47ce4047a5cddbb0af6b4e1efb3dc3862e7c05ddd22e1145e59677f` has a native Linux PTY transcript at `.agent-benchmark/demo/interrupt-recovery-1897300d-native.typescript` and structured report at `.agent-benchmark/demo/interrupt-recovery-1897300d-native.json`. The report records phase 1 as `interrupted/unknown`, phase 2 as `completed/checks_passed`, the same session/task, `runtimeTerminated=true`, `resumed=true`, `duplicateEdits=0`, `checkPassed=true`, and oracle `pass`. The transcript was captured with util-linux `script` under Ubuntu 24.04 WSL2 using native Node 24.14.1; it is a terminal transcript, not a video of the interactive TUI.

This runner is a repeatable terminal demonstration of interruption and recovery. Windows and Ubuntu 24.04 WSL2 native Linux process-group termination have passed locally. The hosted CI run, manual terminal matrix, and continuous TUI screen recording remain separate checks.
