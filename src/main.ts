import { config } from "dotenv";
import { access, copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { createInterface as createQuestionInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { ActionStore } from "./action-store.js";
import {
  appendHistory,
  consumeMultilineInput,
  emptyMultilineState,
  errorText,
  highlightDiff,
  label,
  loadHistory,
  renderMarkdown,
  success,
  warning
} from "./cli-experience.js";
import { loadAppConfig, type AppConfig } from "./config.js";
import { runAgent, type RunAgentResult } from "./agent.js";
import { loadMcpToolManager, type McpToolManager } from "./mcp-client.js";
import { scanProjectWithCache } from "./project-scan.js";
import { loadSecurityPolicy } from "./security.js";
import { finishSession, startSession } from "./session.js";
import type { SecurityPolicy, ToolConfirmationRequest, ToolDefinition } from "./types.js";
import { tools as localTools } from "./tools/registry.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(projectRoot, ".env"), override: true, quiet: true });

type CliState = {
  workspace: string;
  memoryDir: string;
  readonly: boolean;
  maxSteps: number;
  model: string;
  baseURL?: string;
  apiKey?: string;
  yes: boolean;
  config: AppConfig;
  securityPolicy: SecurityPolicy;
  mcpConfigPath?: string;
  mcpManager: McpToolManager;
  tools: ToolDefinition[];
};

async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  if (cliArgs.help) {
    printHelp();
    return;
  }

  const appConfig = await loadAppConfig(cliArgs);
  const workspace = appConfig.workspace;
  const memoryDir = appConfig.memoryDir;
  const securityPolicy = await loadSecurityPolicy(workspace);
  const mcpManager = await loadMcpToolManager({
    workspace,
    projectRoot,
    configPath: appConfig.mcpConfigPath
  });
  const state: CliState = {
    workspace,
    memoryDir,
    readonly: appConfig.readonly,
    maxSteps: appConfig.maxSteps,
    model: appConfig.model,
    baseURL: appConfig.baseURL,
    apiKey: appConfig.apiKey,
    yes: appConfig.yes,
    config: appConfig,
    securityPolicy,
    mcpConfigPath: appConfig.mcpConfigPath,
    mcpManager,
    tools: [...localTools, ...mcpManager.getTools()]
  };
  printMcpWarnings(state.mcpManager);

  if (cliArgs.task) {
    try {
      await runSingleTask(cliArgs.task, state);
    } finally {
      await state.mcpManager.close();
    }
    return;
  }

  try {
    await runInteractiveCli(state);
  } finally {
    await state.mcpManager.close();
  }
}

function parseCliArgs(argv: string[]): {
  task?: string;
  workspace?: string;
  help: boolean;
  readonly?: boolean;
  maxSteps?: number;
  model?: string;
  yes?: boolean;
  mcpConfigPath?: string;
} {
  const taskParts: string[] = [];
  let workspace: string | undefined;
  let help = false;
  let readonly: boolean | undefined;
  let maxSteps: number | undefined;
  let model: string | undefined;
  let yes: boolean | undefined;
  let mcpConfigPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }

    if ((arg === "--max-steps" || arg === "--steps") && argv[index + 1]) {
      maxSteps = parsePositiveInteger(argv[index + 1], "--max-steps");
      index += 1;
      continue;
    }

    if (arg.startsWith("--max-steps=")) {
      maxSteps = parsePositiveInteger(arg.slice("--max-steps=".length), "--max-steps");
      continue;
    }

    if ((arg === "--model" || arg === "-m") && argv[index + 1]) {
      model = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--mcp-config" && argv[index + 1]) {
      mcpConfigPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--mcp-config=")) {
      mcpConfigPath = arg.slice("--mcp-config=".length);
      continue;
    }

    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }

    if (arg === "--readonly" || arg === "--read-only") {
      readonly = true;
      continue;
    }

    if (arg === "--no-readonly" || arg === "--no-read-only") {
      readonly = false;
      continue;
    }

    if ((arg === "--cwd" || arg === "--workspace") && argv[index + 1]) {
      workspace = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--cwd=")) {
      workspace = arg.slice("--cwd=".length);
      continue;
    }

    if (arg.startsWith("--workspace=")) {
      workspace = arg.slice("--workspace=".length);
      continue;
    }

    taskParts.push(arg);
  }

  return {
    task: taskParts.join(" ").trim() || undefined,
    workspace,
    help,
    readonly,
    maxSteps,
    model,
    yes,
    mcpConfigPath
  };
}

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

async function runInteractiveCli(state: CliState): Promise<void> {
  const rl = createInterface({
    input,
    output,
    historySize: 200,
    removeHistoryDuplicates: true
  });
  const prompt = "\nactlume> ";
  const multiline = emptyMultilineState();
  const history = await loadHistory();
  setReadlineHistory(rl, history);

  console.log(success("actlume interactive CLI"));
  printStatus(state);
  console.log("Type /help for commands, /exit to quit.");
  if (input.isTTY) {
    rl.setPrompt(prompt);
    rl.prompt();
  } else {
    output.write(prompt);
  }
  const promptAgain = () => {
    if (input.isTTY) {
      rl.prompt();
    } else {
      output.write(prompt);
    }
  };

  try {
    for await (const rawLine of rl) {
      const multilineResult = consumeMultilineInput(multiline, rawLine);
      if (!multilineResult.ready) {
        rl.setPrompt(multilineResult.prompt);
        promptAgain();
        continue;
      }

      rl.setPrompt(prompt);
      const line = multilineResult.text.trim();
      if (!line) {
        promptAgain();
        continue;
      }

      await appendHistory(line);

      if (line === "/exit" || line === "/quit") {
        return;
      }

      if (line === "/help") {
        printHelp();
        promptAgain();
        continue;
      }

      if (line === "/clear") {
        console.clear();
        promptAgain();
        continue;
      }

      if (line === "/init") {
        await initWorkspace(state);
        promptAgain();
        continue;
      }

      if (line === "/doctor") {
        await printDoctor(state);
        promptAgain();
        continue;
      }

      if (line === "/compact") {
        await compactWorkspaceContext(state);
        promptAgain();
        continue;
      }

      if (line === "/cwd") {
        console.log(state.workspace);
        promptAgain();
        continue;
      }

      if (line === "/readonly") {
        console.log(state.readonly);
        promptAgain();
        continue;
      }

      if (line === "/readonly on") {
        state.readonly = true;
        console.log("readonly: true");
        promptAgain();
        continue;
      }

      if (line === "/readonly off") {
        state.readonly = false;
        console.log("readonly: false");
        promptAgain();
        continue;
      }

      if (line.startsWith("/cwd ")) {
        state.workspace = resolve(line.slice("/cwd ".length).trim());
        state.config = await loadAppConfig({ ...state.config, workspace: state.workspace });
        state.memoryDir = state.config.memoryDir;
        state.readonly = state.config.readonly;
        state.maxSteps = state.config.maxSteps;
        state.model = state.config.model;
        state.baseURL = state.config.baseURL;
        state.apiKey = state.config.apiKey;
        state.yes = state.config.yes;
        state.mcpConfigPath = state.config.mcpConfigPath;
        state.securityPolicy = await loadSecurityPolicy(state.workspace);
        await reloadMcpTools(state);
        console.log(`workspace: ${state.workspace}`);
        promptAgain();
        continue;
      }

      if (line === "/status") {
        printStatus(state);
        promptAgain();
        continue;
      }

      if (line === "/tools") {
        printTools(state.tools);
        promptAgain();
        continue;
      }

      if (line === "/mcp") {
        printMcpStatus(state);
        promptAgain();
        continue;
      }

      if (line === "/mcp tools") {
        printMcpTools(state);
        promptAgain();
        continue;
      }

      if (line === "/mcp reload") {
        await reloadMcpTools(state);
        printMcpStatus(state);
        promptAgain();
        continue;
      }

      if (line === "/memory") {
        await printMemory(state.memoryDir);
        promptAgain();
        continue;
      }

      if (line === "/model") {
        console.log(state.model);
        promptAgain();
        continue;
      }

      if (line.startsWith("/model ")) {
        state.model = line.slice("/model ".length).trim();
        console.log(`model: ${state.model}`);
        promptAgain();
        continue;
      }

      if (line === "/max-steps") {
        console.log(state.maxSteps);
        promptAgain();
        continue;
      }

      if (line.startsWith("/max-steps ")) {
        state.maxSteps = parsePositiveInteger(line.slice("/max-steps ".length).trim(), "/max-steps");
        console.log(`maxSteps: ${state.maxSteps}`);
        promptAgain();
        continue;
      }

      if (line === "/yes") {
        console.log(state.yes);
        promptAgain();
        continue;
      }

      if (line === "/yes on") {
        state.yes = true;
        console.log("yes: true");
        promptAgain();
        continue;
      }

      if (line === "/yes off") {
        state.yes = false;
        console.log("yes: false");
        promptAgain();
        continue;
      }

      await runSingleTask(line, state, (request) => confirmToolCallWithReadline(request, rl));
      promptAgain();
    }
  } finally {
    rl.close();
  }
}

async function runSingleTask(
  userTask: string,
  state: CliState,
  confirm?: (request: ToolConfirmationRequest) => Promise<boolean>
): Promise<void> {
  const session = await startSession(state.memoryDir, userTask);

  try {
    console.log(`[workspace] ${state.workspace}`);
    console.log(`[readonly] ${state.readonly}`);
    console.log(`[model] ${state.model}`);
    console.log(`[maxSteps] ${state.maxSteps}`);
    const result = await runAgent({
      userTask,
      cwd: state.workspace,
      memoryDir: state.memoryDir,
      maxSteps: state.maxSteps,
      readonly: state.readonly,
      model: state.model,
      apiKey: state.apiKey,
      baseURL: state.baseURL,
      runId: session.id,
      tools: state.tools,
      autoConfirm: state.yes,
      securityPolicy: state.securityPolicy,
      confirmToolCall: confirm ?? ((request) => confirmToolCall(request))
    });
    await finishSession(state.memoryDir, session, result.status === "failed" ? "failed" : "completed");
    console.log(label("\n[final answer]"));
    console.log(renderMarkdown(result.answer));
    printRunSummary(result);
  } catch (error) {
    await finishSession(state.memoryDir, session, "failed");
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

function printStatus(state: CliState): void {
  console.log(`${label("workspace")}: ${state.workspace}`);
  console.log(`${label("memoryDir")}: ${state.memoryDir}`);
  console.log(`${label("model")}: ${state.model}`);
  console.log(`${label("baseURL")}: ${state.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}`);
  console.log(`${label("maxSteps")}: ${state.maxSteps}`);
  console.log(`${label("readonly")}: ${state.readonly}`);
  console.log(`${label("yes")}: ${state.yes}`);
  console.log(`${label("security")}: deniedTools=${state.securityPolicy.deniedTools?.length ?? 0}, allowedTools=${state.securityPolicy.allowedTools?.length ?? 0}, shellAllowlist=${state.securityPolicy.shellAllowlist?.length ?? 0}, shellDenylist=${state.securityPolicy.shellDenylist?.length ?? 0}, allowHighRiskShell=${state.securityPolicy.allowHighRiskShell === true}`);
  console.log(`${label("tools")}: ${state.tools.length} (${localTools.length} local, ${state.mcpManager.getTools().length} mcp)`);
  console.log(`${label("mcpConfig")}: ${state.mcpManager.configPath ?? "<none>"}`);
  console.log(`${label("userConfig")}: ${state.config.sources.userConfigLoaded ? state.config.sources.userConfigPath : "<not loaded>"}`);
  console.log(`${label("projectConfig")}: ${state.config.sources.projectConfigLoaded ? state.config.sources.projectConfigPath : "<not loaded>"}`);
}

function printTools(availableTools: ToolDefinition[]): void {
  for (const tool of availableTools) {
    console.log(`${tool.name} [${tool.source ?? "local"}:${tool.sideEffect}] - ${tool.description}`);
  }
}

function printMcpStatus(state: CliState): void {
  console.log(`config: ${state.mcpManager.configPath ?? "<none>"}`);
  console.log(`servers: ${state.mcpManager.statuses.length}`);
  for (const status of state.mcpManager.statuses) {
    if (status.status === "connected") {
      console.log(`- ${status.name}: connected, ${status.toolCount} tools, timeout ${status.toolTimeoutMs}ms`);
    } else {
      console.log(`- ${status.name}: ${status.status}${status.message ? ` - ${status.message}` : ""}`);
    }
  }
  printMcpWarnings(state.mcpManager);
}

function printMcpTools(state: CliState): void {
  const servers = state.mcpManager.servers;
  if (servers.length === 0) {
    console.log("No MCP tools loaded.");
    return;
  }

  for (const server of servers) {
    console.log(`server: ${server.name}`);
    for (const tool of server.tools) {
      console.log(`- ${tool.name} [${tool.sideEffect}]`);
      console.log(`  ${tool.description}`);
      console.log(`  schema: ${JSON.stringify(tool.parameters)}`);
    }
  }
}

function printMcpWarnings(manager: McpToolManager): void {
  for (const warning of manager.warnings) {
    console.warn(`[mcp warning] ${warning}`);
  }
}

async function reloadMcpTools(state: CliState): Promise<void> {
  await state.mcpManager.close();
  state.mcpManager = await loadMcpToolManager({
    workspace: state.workspace,
    projectRoot,
    configPath: state.mcpConfigPath
  });
  state.tools = [...localTools, ...state.mcpManager.getTools()];
}

async function printMemory(memoryDir: string): Promise<void> {
  const actionStore = new ActionStore(memoryDir);
  const actions = await actionStore.list();
  const runsDir = resolve(memoryDir, "runs");
  let runCount = 0;
  try {
    runCount = (await readdir(runsDir)).filter((name) => name.endsWith(".jsonl")).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const lastAction = actions.at(-1);
  console.log(`memoryDir: ${memoryDir}`);
  console.log(`actions: ${actions.length}`);
  console.log(`runs: ${runCount}`);
  if (lastAction) {
    console.log(`lastAction: ${lastAction.timestamp} ${lastAction.toolName ?? "unknown"}`);
  }
}

function printRunSummary(result: RunAgentResult): void {
  console.log(label("\n[run summary]"));
  console.log(`status: ${result.status}`);
  console.log(`steps: ${result.stepsUsed}`);
  console.log(`toolCalls: ${result.toolCalls}`);
  console.log(`runId: ${result.runId}`);
  console.log(`log: ${result.logPath}`);
}

async function confirmToolCall(request: ToolConfirmationRequest): Promise<boolean> {
  printConfirmationRequest(request);

  if (!input.isTTY) {
    console.log("Rejected because stdin is not interactive. Re-run with --yes to auto-confirm.");
    return false;
  }

  const rl = createQuestionInterface({ input, output });
  try {
    const answer = (await rl.question("Approve this tool call? [y/N] ")).trim().toLowerCase();
    return isYes(answer);
  } finally {
    rl.close();
  }
}

async function confirmToolCallWithReadline(request: ToolConfirmationRequest, rl: Interface): Promise<boolean> {
  printConfirmationRequest(request);

  if (!input.isTTY) {
    console.log("Rejected because stdin is not interactive. Re-run with --yes to auto-confirm.");
    return false;
  }

  const answer = await new Promise<string>((resolveAnswer) => {
    rl.question("Approve this tool call? [y/N] ", resolveAnswer);
  });
  return isYes(answer.trim().toLowerCase());
}

function printConfirmationRequest(request: ToolConfirmationRequest): void {
  console.log(warning("\n[confirmation required]"));
  console.log(`tool: ${request.toolName}`);
  console.log(`sideEffect: ${request.sideEffect}`);
  if (request.preview) {
    console.log("[preview]");
    console.log(highlightDiff(request.preview));
  } else {
    console.log("[input]");
    console.log(JSON.stringify(request.input, null, 2));
  }
}

async function initWorkspace(state: CliState): Promise<void> {
  await mkdir(resolve(state.workspace, ".actlume"), { recursive: true });
  await copyIfMissing(resolve(projectRoot, ".actlume", "config.example.json"), resolve(state.workspace, ".actlume", "config.json"));
  await copyIfMissing(resolve(projectRoot, ".agent-mcp.example.json"), resolve(state.workspace, ".agent-mcp.json"));
  await copyIfMissing(resolve(projectRoot, ".agent-security.example.json"), resolve(state.workspace, ".agent-security.json"));
  console.log(success("Initialized workspace config files."));
  console.log(`- ${resolve(state.workspace, ".actlume", "config.json")}`);
  console.log(`- ${resolve(state.workspace, ".agent-mcp.json")}`);
  console.log(`- ${resolve(state.workspace, ".agent-security.json")}`);
}

async function printDoctor(state: CliState): Promise<void> {
  console.log(label("doctor"));
  console.log(`${check(Number(process.versions.node.split(".")[0]) >= 22)} Node.js ${process.version}`);
  console.log(`${check(Boolean(state.apiKey ?? process.env.OPENAI_API_KEY))} API key configured`);
  console.log(`${check(Boolean(state.model))} model: ${state.model}`);
  console.log(`${check(await exists(state.workspace))} workspace: ${state.workspace}`);
  console.log(`${check(state.mcpManager.warnings.length === 0)} MCP warnings: ${state.mcpManager.warnings.length}`);
  for (const item of state.mcpManager.warnings) {
    console.log(`  ${warning(item)}`);
  }
  console.log(`${check(true)} memoryDir: ${state.memoryDir}`);
  console.log(`${check(true)} tools: ${state.tools.length}`);
}

async function compactWorkspaceContext(state: CliState): Promise<void> {
  const result = await scanProjectWithCache(state.workspace, {
    maxDepth: 3,
    maxFiles: 250,
    memoryDir: state.memoryDir,
    forceRefresh: true
  });
  console.log(success("Compacted project context."));
  console.log(`summary: ${result.summaryPath ?? "<not persisted>"}`);
  console.log(`cache: ${result.cachePath ?? "<not persisted>"}`);
}

async function copyIfMissing(source: string, target: string): Promise<void> {
  if (await exists(target)) {
    console.log(warning(`Skipped existing file: ${target}`));
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function check(ok: boolean): string {
  return ok ? success("OK") : errorText("FAIL");
}

function setReadlineHistory(rl: Interface, history: string[]): void {
  (rl as Interface & { history?: string[] }).history = history;
}

function isYes(answer: string): boolean {
  return answer === "y" || answer === "yes";
}

function printHelp(): void {
  console.log(`Usage:
  actlume "task"
  actlume --cwd D:\\workspace\\my-app "task"
  actlume --readonly "inspect without modifying"
  actlume --max-steps 20 --model gpt-4.1-mini "task"
  actlume --mcp-config .agent-mcp.json "task"
  actlume --yes "task"
  ma

Interactive commands:
  /help          Show this help
  /cwd           Print current workspace
  /cwd <path>    Switch workspace
  /status        Print workspace, model, readonly, and memory settings
  /tools         List available tools
  /mcp           Show MCP status
  /mcp tools     List MCP tools and schemas
  /mcp reload    Reload MCP servers from config
  /memory        Show memory counts
  /init          Create config examples in the current workspace
  /doctor        Check local environment and configuration
  /compact       Refresh project summary and index cache
  /clear         Clear the terminal
  /model         Print current model
  /model <name>  Switch model
  /max-steps     Print max steps
  /max-steps <n> Set max steps
  /readonly      Print readonly mode
  /readonly on   Enable readonly mode
  /readonly off  Disable readonly mode
  /yes           Print auto-confirm flag
  /yes on        Enable auto-confirm flag
  /yes off       Disable auto-confirm flag
  /exit          Quit
`);
}

await main();
