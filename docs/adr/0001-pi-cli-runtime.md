# ADR 0001: Use the Pi CLI process as Actlume's execution host

- Status: accepted for the first migrated runtime
- Date: 2026-10-05
- Decision owners: Actlume project

## Context

Actlume needs an interactive terminal, headless task execution, resumable sessions, MCP support, and extension hooks. Rebuilding these facilities inside a custom agent loop would duplicate runtime behavior, while embedding only a session SDK object would not by itself create the full terminal application lifecycle.

## Decision

Actlume starts the public Pi CLI entry point as a child process. Pi owns the model loop, transcript, terminal UI, and MCP lifecycle. Actlume loads an extension that supplies project context, local tools, permission checks, run-scoped workflow state, memory, verification evidence, and local runtime events. Headless work uses Pi's RPC interface with the same Actlume tool adapter. The old ReAct runtime stays available behind the explicit `--legacy` compatibility path.

Actlume keeps its own domain state only where it adds application semantics: memory lifecycle, workspace verification fingerprints, workflow decisions, run/agent correlation, and bounded context/artifact references. Pi's transcript remains the conversation source of truth. Optional trace export serializes a privacy-filtered subset of Actlume events as OTLP/HTTP; it does not replace the local event journal.

## Consequences

- Users get Pi's terminal and session behavior without Actlume maintaining a second transcript or MCP process manager.
- The public CLI and extension hooks are an explicit dependency boundary; package identity, CLI flags, extension APIs, and MCP config compatibility need version-pinned tests.
- The process boundary allows an explicit workspace `cwd` without changing the host process's global working directory.
- Some historical MCP options (`startupTimeoutMs` and `toolPrefix`) have no exact Pi mapping.
- Actlume-specific reliability claims must be demonstrated separately from Pi's base capabilities through task fixtures and independent validators.
- `scopedResearch` and OTLP export are optional prototypes; their presence is not evidence that they improve task results.

## Revisit when

Revisit this decision if Pi's public CLI/extension surface becomes unstable or prevents a required, independently validated Actlume behavior. Compare the maintenance cost of an embedded SDK runtime against the current process boundary before replacing it.
