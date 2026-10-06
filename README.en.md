# actlume

`actlume` is a local Coding Agent written in TypeScript. Pi provides the model loop, session transcript, and terminal TUI. Actlume owns project context, tool permissions, memory lifecycle, workflow state, and verification evidence.

## Capabilities

- With no arguments, opens Pi TUI. A positional task starts as the first prompt in the TUI when a terminal is available; scripts and piped use run through Pi RPC.
- Registers Actlume's existing local tools through Pi's tool API, preserving input validation, structured errors, and configured MCP servers.
- Loads `ACTLUME.md` / `CLAUDE.md` and `.actlume/rules/*.md`. Memories include type, scope, source, lifecycle status, and optional file fingerprints.
- New memories are candidates. Legacy memories without lifecycle metadata become `needs_review`. Use `/actlume-memory promote <filename>` in the TUI to confirm promotion.
- Permission hooks enforce read-only mode, tool allow/deny rules, shell risk checks, and sensitive-path approval. Actions that need a human but have no interactive UI are denied.
- Pi runs keep workflow plans and tool history scoped per run and apply exploration and repeated-failure guardrails. If files changed without a current passing verification, the agent is asked to verify or report the result as unverified.
- Structured events correlate session, run, agent, and tool-call IDs. Only commands matching a `CheckSpec` in `.actlume/checks.json` create verification evidence bound to workspace, environment, and task identity. A passing check establishes success for that scope and fingerprint; it does not independently prove task requirements.
- `/actlume-memory`, `/actlume-context`, `/actlume-changes`, `/actlume-verify`, `/actlume-result`, and `/actlume-doctor` expose memory, context, changes, verification, and run outcome. `/actlume-legacy` browses old JSON sessions; `/actlume-import <id>` explicitly imports one as attributed historical text.
- The experimental `scopedResearch` tool runs up to three parallel read-only subtasks in separate Pi sessions, with an allowlisted tool set, step/timeout budgets, and parent cancellation. This limits callable tools; it is not an OS or per-path filesystem sandbox. Local events can optionally be exported as OTLP/HTTP spans with failure diagnostics.

## Requirements and install

- Node.js `>=22.19.0`
- npm
- OpenAI or OpenAI-compatible API key

```bash
npm install
```

Copy `.env.example` to `.env`:

```powershell
Copy-Item .env.example .env
```

Example configuration:

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
AGENT_MAX_STEPS=10
AGENT_MEMORY_DIR=.agent-memory
# Optional OTLP/HTTP trace export. Add collector authentication with
# ACTLUME_OTEL_EXPORTER_OTLP_HEADERS when needed; never commit credentials.
ACTLUME_OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example/otel
ACTLUME_OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20your-token
```

Run:

```bash
npm start
npm start -- --cwd D:\workspace\my-app
```

Register a global command with `npm link`:

```bash
actlume "Analyze the main risks in this project"
actlume --plan
actlume --readonly
actlume --yes "Fix a small issue and run checks"
```

Run `actlume --doctor` to check Node/Pi CLI, shell startup, data-directory read/write, provider configuration, and MCP connection status. It does not call a model API. Only `actlume --doctor --probe-provider` sends one minimal request to the configured OpenAI-compatible endpoint, capped at one output token.

Tasks launched in a terminal use Pi TUI. In a non-interactive process, approval-required actions are blocked; `--yes` explicitly selects bypass permissions.

## Sessions and compatibility

Pi transcripts are stored under `.agent-memory/pi-sessions`; structured events and verification records go under `.agent-memory/events` and `.agent-memory/verification`. `--resume` accepts Pi sessions recorded by Actlume:

```bash
actlume --resume
actlume --resume <pi-session-id> "Continue this task"
```

Old Actlume JSON transcripts are not converted into fake Pi messages. They remain resumable with the legacy UI:

```bash
actlume --legacy --resume <old-session-id>
```

The old ReAct runtime, snapshots, and workflow guardrails are retained only on the `--legacy` path.

## Development checks

```bash
npm run typecheck
npm test
npm run benchmark
npm run ci
npm run smoke:package
```

`npm run ci` runs typechecking, tests, and deterministic benchmarks. `npm run smoke:package` installs the npm tarball into a unique temporary consumer and checks the production entry, a headless mock task, resume, Pi tool registration, and an independent oracle; the report goes under ignored `.agent-benchmark/package-smoke`. The benchmark creates a unique temporary Git workspace and deletes only the path created for that run; it leaves any repository `.agent-benchmark` directory untouched. Tests, package smoke, and Eval protocol cards use local deterministic providers and do not call a real model. All nine core cards pass the protocol/oracle checks on Windows and Ubuntu 24.04 WSL2 with native Linux Node; these validate runtime/failure/recording contracts only. Real-model campaigns ran on source candidate `eb941e32`, followed by a source candidate that differs only in two README files. The 24 development attempts and eight post-freeze confirmation attempts have complete usage accounting, but oracle outcomes were mixed, provider revision/sampling are unknown, and the confirmation reused earlier task cards; there is no strategy-benefit or unseen-task generalization claim. Two earlier candidate campaigns stopped when usage was unknown. See [`evals/README.md`](evals/README.md), the [experiment report](docs/ACTLUME-ROUND-2-EXPERIMENT-REPORT.md), and the [architecture diagram](docs/ACTLUME-ARCHITECTURE.md).

## Main modules

```text
src/main.ts              CLI routing for Pi and the compatibility runtime
src/pi-runtime.ts        Pi CLI/RPC, tool adaptation, approval, and policies
src/pi-extension.ts      Extension entry point loaded by Pi
src/pi-workflow.ts       Run-local workflow state and exploration/failure guardrails
src/runtime-events.ts    Structured session/run/agent/toolCall events
src/otel-exporter.ts     Optional OTLP/HTTP trace mapping and export
src/verification.ts      Git baseline, check records, and outcome assessment
src/context-budget.ts    Budget for injected project instructions and memories
src/memory.ts            Versioned memory metadata, lifecycle, and applicability
src/security.ts          Permission modes, shell risk, and sensitive paths
src/agent.ts             Legacy ReAct runtime (--legacy only)
src/workflow-guard.ts    Legacy runtime workflow guardrails
src/tools/               Actlume local tools
```

## Current limits

- MCP configuration is bridged to Pi with extension auto-discovery disabled. Actlume and Pi's MCP extension are loaded explicitly. On the Pi path, MCP `startupTimeoutMs` and custom `toolPrefix` are not applied; `/actlume-doctor` reports those migration notes. The legacy runtime still honors its old fields.
- Memory retrieval is keyword, CJK bigram/trigram, and substring based. Conflicts are retained for review instead of being automatically resolved.
- `AGENT_MAX_STEPS` limits Pi model turns. A settled runtime means the run stopped; task outcome still depends on code changes and matching verification evidence.
- `scopedResearch` is currently limited to three parallel read-only tasks; it does not provide parallel write worktrees or OS/per-path isolation, and the parent must review its findings.
- The OTLP exporter is a small OTLP/HTTP span serializer, not automatic instrumentation through the OpenTelemetry SDK. HTTP/network/timeout losses are counted and shown in the TUI/doctor; local JSONL remains the source record. A hosted collector or Langfuse deployment has not been tested.
- MCP `startupTimeoutMs` and `toolPrefix` have no exact Pi equivalents. Exactly-once recovery for MCP or other remote side effects and independent requirement verification are not implemented.
- Real-model development (24 attempts) and post-freeze confirmation (8 attempts) completed with full usage reporting on source candidate `eb941e32`; the latest source candidate differs only in the README files. Results are descriptive only: provider revision/sampling are unknown, the confirmation cards were exercised earlier, and neither experiment establishes a resolve rate, memory benefit, ablation gain, or cost claim. Protocol cards validate runtime contracts and the summary harness computes supplied results; neither demonstrates model gains. Process-tree cancellation has been exercised on Windows and Ubuntu 24.04 under WSL2 with native Linux Node; a CLI/PTTY interruption-recovery transcript is saved. Hosted GitHub CI, the manual TUI matrix, and an interactive TUI screen recording remain pending.
