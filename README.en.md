# actlume

`actlume` is a local ReAct Agent CLI written in TypeScript. It is built to make the `Reason -> Act -> Observe -> Final` loop easy to inspect, run, and extend toward a usable coding-assistant prototype.

It is currently useful for project inspection, file search, small code edits, check commands, task tracking, and external tools through MCP.

## Capabilities

- OpenAI-compatible Chat Completions: works with OpenAI, DeepSeek, and compatible services.
- Local tools: project scan, edit planning, tree, text search, file IO, patching, controlled shell, recall, and task tracking.
- Interactive CLI: supports one-shot tasks and ongoing sessions.
- Safety controls: write, patch, shell, and non-read-only MCP calls require confirmation by default; `--readonly` and `--yes` are available.
- MCP extension: external search, browser, database, GitHub, and similar tools can be connected through `.agent-mcp.json`.
- Logs and memory: tool calls, task state, and run logs are written to `.agent-memory`.
- Code editing workflow: `editPlan` is required before file edits, changes are summarized afterwards, and suggested checks can run automatically.
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

## Usage

Run inside this project:

```bash
npm start -- "Inspect the current project structure and summarize it"
npm start
npm run typecheck
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
/mcp reload    Reload MCP servers
/memory        Show memory stats
/model <name>  Switch model
/readonly on   Enable readonly mode
/readonly off  Disable readonly mode
/yes on        Enable auto-confirm
/yes off       Disable auto-confirm
/exit          Quit
```

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
      "toolPrefix": "mcp_search"
    }
  }
}
```

Note: actlume does not include built-in web search yet. Realtime information, news, scores, and web pages should come from MCP or a future web search tool.

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
|   |-- project-scan.ts  Project scanning
|   |-- mcp-client.ts    MCP bridge
|   |-- tools/           Local tools
|   `-- benchmark.ts     Benchmark runner
|-- README.md
|-- README.en.md
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
- [ ] Permissions and safety
  - [ ] Add command risk detection.
  - [ ] Restrict writes to the current workspace by default.
  - [ ] Support tool permission config and command allowlists / denylists.
- [ ] Configuration system
  - [ ] Support project-level `.actlume/config.json`.
  - [ ] Support user-level `~/.actlume/config.json`.
  - [ ] Define precedence for CLI args, project config, user config, environment variables, and defaults.
- [ ] MCP and networked capabilities
  - [ ] Improve MCP status, tool display, timeouts, and diagnostics.
  - [ ] Provide an example web search MCP config.
  - [ ] Require search tools for realtime-information questions.
- [ ] Interactive CLI experience
  - [ ] Command history and multiline input.
  - [ ] Colored output, Markdown rendering, and diff highlighting.
  - [ ] `/init`, `/doctor`, `/compact`, and `/clear` helper commands.
- [ ] Model adapters and diagnostics
  - [ ] Standardize diagnostics for OpenAI-compatible services.
  - [ ] Add model capability metadata and JSON repair retries.
- [ ] Tests, CI, and release
  - [ ] Add unit tests and CLI integration tests.
  - [ ] Add MCP mock server tests.
  - [ ] Configure GitHub Actions.
  - [ ] Prepare npm release scripts and changelog.

## Development Checks

```bash
npm run typecheck
npm run benchmark
```

The current benchmark covers file reading, search, project scan, edit planning, readonly protection, patching, shell, task tracking, and invalid tool input.

## Safety Notes

- Prefer using it first inside a Git repo or test workspace.
- Without `--yes`, write and execute tools request confirmation.
- `--readonly` blocks write and execute tools.
- `.env`, `.agent-mcp.json`, and `.agent-memory/` should not be committed.
