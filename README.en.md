# actlume

`actlume` is a local ReAct Agent CLI written in TypeScript. It is built to make the `Reason -> Act -> Observe -> Final` loop easy to inspect, run, and extend toward a usable coding-assistant prototype.

It is currently useful for project inspection, file search, small code edits, check commands, task tracking, and external tools through MCP.

## Capabilities

- OpenAI-compatible Chat Completions: works with OpenAI, DeepSeek, and compatible services.
- Local tools: project scan, edit planning, tree, text search, file IO, patching, controlled shell, recall, and task tracking.
- Interactive CLI: supports one-shot tasks and ongoing sessions.
- CLI experience: command history, multiline input, colored output, diff highlighting, and helper commands.
- Safety controls: write, patch, shell, and non-read-only MCP calls require confirmation by default; `--readonly`, `--yes`, and `.agent-security.json` are available.
- Configuration system: CLI args, project config, user config, environment variables, and defaults are merged by precedence.
- MCP extension: external search, browser, database, GitHub, and similar tools can be connected through `.agent-mcp.json`.
- Logs and memory: tool calls, task state, and run logs are written to `.agent-memory`.
- Code editing workflow: `editPlan` is required before file edits, changes are summarized afterwards, and suggested checks can run automatically.
- Model adapters and diagnostics: detects OpenAI, DeepSeek, Ollama, and generic OpenAI-compatible services, with clearer authentication, gateway, rate-limit, and protocol errors.
- Tests and release: includes unit tests, CLI integration tests, MCP mock server tests, GitHub Actions, CI scripts, and an npm dry-run release script.
- Benchmark: a fixed suite validates core tools and control flow.

## Requirements

- Node.js >= 22
- npm
- OpenAI or OpenAI-compatible API key

## Install

```bash
npm install
```

Copy the env example:

```powershell
Copy-Item .env.example .env
```

Edit `.env`:

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
AGENT_MAX_STEPS=10
AGENT_MEMORY_DIR=.agent-memory
AGENT_READONLY=false
AGENT_MCP_CONFIG=
```

DeepSeek example:

```env
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-pro
```

## Configuration

Config precedence from highest to lowest:

1. CLI arguments
2. Project-level `.actlume/config.json`
3. User-level `~/.actlume/config.json`
4. Environment variables / `.env`
5. Defaults

Start from the example file:

```powershell
Copy-Item .actlume/config.example.json .actlume/config.json
```

Supported fields:

```json
{
  "workspace": ".",
  "memoryDir": ".agent-memory",
  "readonly": false,
  "maxSteps": 10,
  "model": "gpt-4.1-mini",
  "baseURL": "https://api.openai.com/v1",
  "mcpConfigPath": ".agent-mcp.json",
  "yes": false
}
```

`apiKey` can also be placed in config files, but `.env` or system environment variables are preferred.

## Usage

Run inside this project:

```bash
npm start -- "Inspect the current project structure and summarize it"
npm start
npm run typecheck
npm run test
npm run benchmark
```

Register global commands:

```bash
npm link
```

Then use from any directory:

```powershell
actlume
ma
actlume "Inspect the current project structure and summarize it"
actlume --cwd D:\workspace\my-app "Analyze this project"
actlume --readonly "Inspect without modifying files"
actlume --yes "Fix a small issue and run checks"
```

Common interactive commands:

```text
/help          Show help
/cwd           Print current workspace
/cwd <path>    Switch workspace
/status        Show model, workspace, readonly mode, and memory dir
/tools         List available tools
/mcp           Show MCP status
/mcp tools     Show MCP tools and schemas
/mcp reload    Reload MCP servers
/memory        Show memory stats
/init          Initialize config files in the current workspace
/doctor        Check local environment and configuration
/compact       Refresh project summary and index cache
/clear         Clear the terminal
/model <name>  Switch model
/readonly on   Enable readonly mode
/readonly off  Disable readonly mode
/yes on        Enable auto-confirm
/yes off       Disable auto-confirm
/exit          Quit
```

Use a trailing backslash for multiline input:

```text
Analyze this issue,\
then suggest a fix
```

Interactive command history is saved to `~/.actlume/history`.

## MCP

MCP is the recommended way to add external capabilities. Config lookup order:

1. `--mcp-config <path>`
2. `AGENT_MCP_CONFIG`
3. `.agent-mcp.json` in the current workspace
4. `.agent-mcp.json` in the actlume project directory

Example:

```powershell
Copy-Item .agent-mcp.example.json .agent-mcp.json
```

Config shape:

```json
{
  "servers": {
    "search": {
      "command": "npx",
      "args": ["-y", "some-search-mcp-server"],
      "env": {
        "SEARCH_API_KEY": "your_key_here"
      },
      "cwd": ".",
      "toolPrefix": "mcp_search",
      "startupTimeoutMs": 15000,
      "toolTimeoutMs": 60000
    }
  }
}
```

`/mcp` shows server status, disabled/failed reasons, and tool counts. `/mcp tools` shows MCP tool names, side-effect type, and input schemas.

Note: actlume does not include built-in web search. Realtime information, news, scores, and web pages should come from MCP web search, browser, or fetch tools. The agent detects these tasks; if no search-like MCP tool is available, it asks you to configure network search instead of guessing.

## Security Policy

By default, file writes and patches are restricted to the current workspace, and dangerous shell commands are blocked. Start from the example file:

```powershell
Copy-Item .agent-security.example.json .agent-security.json
```

Supported policy fields:

- `allowedTools` / `deniedTools`: tool allowlist / denylist with exact names or `*` wildcards.
- `shellAllowlist` / `shellDenylist`: shell command regex allowlist / denylist.
- `allowHighRiskShell`: whether to allow high-risk commands such as `git reset --hard` or `npm publish`.

Environment overrides are also supported: `AGENT_ALLOWED_TOOLS`, `AGENT_DENIED_TOOLS`, `AGENT_SHELL_ALLOWLIST`, `AGENT_SHELL_DENYLIST`, and `AGENT_ALLOW_HIGH_RISK_SHELL`.

## Main Tools

- `projectScan`: generate a lightweight project index, language distribution, key files, scripts, and suggested checks, cached in `.agent-memory/project-index.json`.
- `editPlan`: record the planned change, expected files, and steps before editing files.
- `listDir` / `tree`: inspect directories.
- `searchText`: search text with a JavaScript regular expression.
- `readFile` / `writeFile` / `appendFile` / `fileExists`: file operations.
- `applyPatch`: apply a unified diff.
- `shell`: run a controlled shell command.
- `recall`: search historical actions.
- `taskList` / `taskAdd` / `taskUpdate`: track tasks.

## Project Layout

```text
actlume/
|-- bin/                 Global CLI entry
|-- src/
|   |-- main.ts          CLI entry and interactive mode
|   |-- agent.ts         ReAct loop
|   |-- llm.ts           LLM wrapper
|   |-- model-adapter.ts Model adapters and diagnostics
|   |-- project-scan.ts  Project scanning
|   |-- mcp-client.ts    MCP bridge
|   |-- tools/           Local tools
|   |-- test-fixtures/   Test fixtures
|   `-- benchmark.ts     Benchmark runner
|-- .github/workflows/   CI workflow
|-- CHANGELOG.md
|-- README.md
|-- README.en.md
|-- .actlume/config.example.json
|-- package.json
`-- tsconfig.json
```

## Build TODO

The goal is to move `actlume` from a learning MVP toward a usable prototype.

- [x] Project scanning and context indexing
  - [x] Add the `projectScan` tool.
  - [x] Detect project kinds, language distribution, key files, package scripts, and suggested checks.
  - [x] Inject a lightweight project snapshot into the Agent prompt.
  - [x] Persist project summaries to `.agent-memory/project-summary.md`.
  - [x] Add fingerprint validation, incremental reuse, and caching for large repositories.
- [x] Code editing workflow
  - [x] Produce an edit plan and expected file list before changes.
  - [x] Summarize diffs after changes.
  - [x] Detect and run suitable checks automatically.
  - [x] Support limited automatic repair after check failures.
- [x] Permissions and safety
  - [x] Add command risk detection.
  - [x] Restrict writes to the current workspace by default.
  - [x] Support tool permission config and command allowlists / denylists.
- [x] Configuration system
  - [x] Support project-level `.actlume/config.json`.
  - [x] Support user-level `~/.actlume/config.json`.
  - [x] Define precedence for CLI args, project config, user config, environment variables, and defaults.
- [x] MCP and networked capabilities
  - [x] Improve MCP status, tool display, timeouts, and diagnostics.
  - [x] Provide an example web search MCP config.
  - [x] Require search tools for realtime-information questions.
- [x] Interactive CLI experience
  - [x] Command history and multiline input.
  - [x] Colored output, Markdown rendering, and diff highlighting.
  - [x] `/init`, `/doctor`, `/compact`, and `/clear` helper commands.
- [x] Model adapters and diagnostics
  - [x] Standardize diagnostics for OpenAI-compatible services.
  - [x] Add model capability metadata and JSON repair retries.
- [x] Tests, CI, and release
  - [x] Add unit tests and CLI integration tests.
  - [x] Add MCP mock server tests.
  - [x] Configure GitHub Actions.
  - [x] Prepare npm release scripts and changelog.

## Development Checks

```bash
npm run typecheck
npm run test
npm run benchmark
npm run ci
npm run release:dry
```

The current benchmark covers file reading, search, project scan, edit planning, CLI experience helpers, readonly protection, patching, shell, security policy, config precedence, MCP status, realtime-information guard, task tracking, and invalid tool input. `npm test` covers model diagnostics, JSON repair, CLI integration, and the MCP mock server.

## Safety Notes

- Prefer using it first inside a Git repo or test workspace.
- Without `--yes`, write and execute tools request confirmation.
- `--readonly` blocks write and execute tools.
- `.env`, `.agent-mcp.json`, `.agent-security.json`, `.actlume/config.json`, and `.agent-memory/` should not be committed.
