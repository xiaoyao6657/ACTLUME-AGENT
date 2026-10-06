import { config } from "dotenv";
import { randomUUID } from "node:crypto";
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
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { runAgent, type RunAgentResult } from "./agent.js";
import { loadMcpToolManager, type McpToolManager } from "./mcp-client.js";
import { listMemories } from "./memory.js";
import { readPlanFile } from "./plan-mode.js";
import { scanProjectWithCache } from "./project-scan.js";
import { loadSecurityPolicy, normalizePermissionMode } from "./security.js";
import { findLatestRuntimeSession, readRuntimeEvents } from "./runtime-events.js";
import { discoverSkills, getSkillByName, resolveSkillPrompt } from "./skills.js";
import {
  finishSession,
  getLatestSessionSnapshot,
  listSessionSnapshots,
  loadSessionSnapshot,
  saveSessionSnapshot,
  startSession,
  type SessionSnapshot
} from "./session.js";
import type { EditWorkflowState } from "./edit-workflow.js";
import type { AgentHistoryItem, PermissionMode, SecurityPolicy, ToolConfirmationRequest, ToolDefinition } from "./types.js";
import { tools as localTools } from "./tools/registry.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Keep explicit process/CI settings authoritative; .env fills in only missing values.
config({ path: resolve(projectRoot, ".env"), quiet: true });

type CliState = {
  workspace: string;
  memoryDir: string;
  readonly: boolean;
  permissionMode: PermissionMode;
  maxSteps?: number;
  model: string;
  baseURL?: string;
  apiKey?: string;
  yes: boolean;
  config: AppConfig;
  securityPolicy: SecurityPolicy;
  mcpConfigPath?: string;
  mcpManager: McpToolManager;
  tools: ToolDefinition[];
  resumeFrom?: string;
  initialHistory?: AgentHistoryItem[];
  initialWorkflowState?: EditWorkflowState;
  streaming: boolean;
};

async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  if (cliArgs.help) {
    printHelp();
    return;
  }

  if (cliArgs.json && !cliArgs.task) {
    console.error("--json requires a task prompt.");
    process.exitCode = 2;
    return;
  }

  if (cliArgs.probeProvider && !cliArgs.doctor) {
    console.error("--probe-provider requires --doctor.");
    process.exitCode = 2;
    return;
  }

  const appConfig = await loadAppConfig(cliArgs);
  const workspace = appConfig.workspace;
  const memoryDir = appConfig.memoryDir;
  if (cliArgs.doctor) {
    const { resolvePiCliPath } = await import("./pi-runtime.js");
    const report = await runDoctor({
      workspace,
      memoryDir,
      projectRoot,
      piCliPath: resolvePiCliPath(),
      model: appConfig.model,
      baseURL: appConfig.baseURL,
      apiKey: appConfig.apiKey ?? process.env.OPENAI_API_KEY,
      mcpConfigPath: appConfig.mcpConfigPath,
      probeProvider: cliArgs.probeProvider
    });
    console.log(formatDoctorReport(report));
    process.exitCode = report.exitCode;
    return;
  }
  const securityPolicy = await loadSecurityPolicy(workspace);
  if (!cliArgs.legacy) {
    const { launchPiInteractive, resolvePiCliPath, runPiTask, runPiTaskDetailed } = await import("./pi-runtime.js");
    const resumedSessionId = cliArgs.resume
      ? await resolvePiSessionId(memoryDir, workspace, cliArgs.resume)
      : undefined;
    const sessionId = resumedSessionId ?? (cliArgs.task ? randomUUID() : undefined);
    if (cliArgs.task && input.isTTY && output.isTTY) {
      process.exitCode = await launchPiInteractive(appConfig, securityPolicy, { sessionId, prompt: cliArgs.task });
    } else if (cliArgs.task) {
      if (cliArgs.json) {
        const result = await runPiTaskDetailed(appConfig, securityPolicy, cliArgs.task, sessionId ?? randomUUID(), { silent: true });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exitCode = result.exitCode;
      } else {
        process.exitCode = await runPiTask(appConfig, securityPolicy, cliArgs.task, sessionId ?? randomUUID());
      }
    } else {
      process.exitCode = await launchPiInteractive(appConfig, securityPolicy, { sessionId });
    }
    return;
  }

  const mcpManager = await loadMcpToolManager({
    workspace,
    projectRoot,
    configPath: appConfig.mcpConfigPath
  });
  const state: CliState = {
    workspace,
    memoryDir,
    readonly: appConfig.readonly,
    permissionMode: appConfig.permissionMode,
    maxSteps: appConfig.maxSteps,
    model: appConfig.model,
    baseURL: appConfig.baseURL,
    apiKey: appConfig.apiKey,
    yes: appConfig.yes,
    config: appConfig,
    securityPolicy,
    mcpConfigPath: appConfig.mcpConfigPath,
    mcpManager,
    tools: [...localTools, ...mcpManager.getTools()],
    streaming: appConfig.streaming
  };
  printMcpWarnings(state.mcpManager);
  if (cliArgs.resume) {
    await applyResumeOption(state, cliArgs.resume);
  }

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

async function resolvePiSessionId(
  memoryDir: string,
  workspace: string,
  resume: string | true
): Promise<string | undefined> {
  if (resume === true) {
    const latest = await findLatestRuntimeSession(memoryDir, workspace);
    if (!latest) throw new Error("No Actlume Pi session is available to resume in this workspace.");
    const latestEvents = await readRuntimeEvents(memoryDir, latest);
    if (!await hasPiTranscriptFile(latestEvents, workspace)) {
      throw new Error("The latest Actlume Pi session has no readable transcript file to resume.");
    }
    return latest;
  }
  const events = await readRuntimeEvents(memoryDir, resume);
  if (!await hasPiTranscriptFile(events, workspace)) {
    throw new Error(`Pi session not found in this workspace: ${resume}. Older Actlume JSON sessions can still be opened with --legacy --resume ${resume}.`);
  }
  return resume;
}

async function hasPiTranscriptFile(events: Awaited<ReturnType<typeof readRuntimeEvents>>, workspace: string): Promise<boolean> {
  const sessionStart = events.find((event) =>
    event.kind === "session_started" && event.workspace === workspace && Boolean(event.attributes?.sessionFile)
  );
  const sessionFile = sessionStart?.attributes?.sessionFile;
  if (typeof sessionFile !== "string" || !sessionFile) return false;
  try {
    await access(sessionFile);
    return true;
  } catch {
    return false;
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
  resume?: string | true;
  permissionMode?: PermissionMode;
  streaming?: boolean;
  legacy?: boolean;
  json?: boolean;
  doctor?: boolean;
  probeProvider?: boolean;
} {
  const taskParts: string[] = [];
  let workspace: string | undefined;
  let help = false;
  let readonly: boolean | undefined;
  let maxSteps: number | undefined;
  let model: string | undefined;
  let yes: boolean | undefined;
  let mcpConfigPath: string | undefined;
  let resume: string | true | undefined;
  let permissionMode: PermissionMode | undefined;
  let streaming: boolean | undefined;
  let legacy = false;
  let json = false;
  let doctor = false;
  let probeProvider = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      yes = true;
      permissionMode = "bypassPermissions";
      continue;
    }

    if (arg === "--yolo") {
      yes = true;
      permissionMode = "bypassPermissions";
      continue;
    }

    if (arg === "--plan") {
      readonly = true;
      permissionMode = "plan";
      continue;
    }

    if (arg === "--accept-edits") {
      permissionMode = "acceptEdits";
      continue;
    }

    if (arg === "--dont-ask") {
      permissionMode = "dontAsk";
      continue;
    }

    if (arg === "--stream") {
      streaming = true;
      continue;
    }

    if (arg === "--legacy") {
      legacy = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--doctor") {
      doctor = true;
      continue;
    }

    if (arg === "--probe-provider") {
      probeProvider = true;
      continue;
    }

    if (arg === "--resume") {
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        resume = next;
        index += 1;
      } else {
        resume = true;
      }
      continue;
    }

    if (arg.startsWith("--resume=")) {
      resume = arg.slice("--resume=".length) || true;
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
    mcpConfigPath,
    resume,
    permissionMode,
    streaming,
    legacy,
    json,
    doctor,
    probeProvider
  };
}

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function parsePermissionModeCli(value: string): PermissionMode {
  const mode = normalizePermissionMode(value);
  if (!mode) {
    throw new Error(`permission mode must be one of: default, plan, acceptEdits, dontAsk, bypassPermissions`);
  }
  return mode;
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

      if (line === "/permission") {
        console.log(state.permissionMode);
        promptAgain();
        continue;
      }

      if (line.startsWith("/permission ")) {
        const mode = parsePermissionModeCli(line.slice("/permission ".length).trim());
        state.permissionMode = mode;
        if (mode === "plan") {
          state.readonly = true;
        }
        if (mode === "bypassPermissions") {
          state.yes = true;
        }
        console.log(`permissionMode: ${state.permissionMode}`);
        promptAgain();
        continue;
      }

      if (line.startsWith("/cwd ")) {
        state.workspace = resolve(line.slice("/cwd ".length).trim());
        state.config = await loadAppConfig({ ...state.config, workspace: state.workspace });
        state.memoryDir = state.config.memoryDir;
        state.readonly = state.config.readonly;
        state.permissionMode = state.config.permissionMode;
        state.maxSteps = state.config.maxSteps;
        state.model = state.config.model;
        state.baseURL = state.config.baseURL;
        state.apiKey = state.config.apiKey;
        state.yes = state.config.yes;
        state.mcpConfigPath = state.config.mcpConfigPath;
        state.streaming = state.config.streaming;
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

      if (line === "/sessions") {
        await printSessions(state.memoryDir);
        promptAgain();
        continue;
      }

      if (line === "/plan" || line.startsWith("/plan ")) {
        await handlePlanCommand(line, state, (request) => confirmToolCallWithReadline(request, rl));
        promptAgain();
        continue;
      }

      if (line === "/skills") {
        printSkills(state.workspace);
        promptAgain();
        continue;
      }

      if (line === "/resume" || line.startsWith("/resume ")) {
        const id = line === "/resume" ? true : line.slice("/resume ".length).trim();
        await applyResumeOption(state, id || true);
        promptAgain();
        continue;
      }

      if (line.startsWith("/")) {
        const handled = await maybeInvokeSkillCommand(line, state, (request) => confirmToolCallWithReadline(request, rl));
        if (handled) {
          promptAgain();
          continue;
        }
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
  const session = await startSession(state.memoryDir, userTask, state.resumeFrom);

  try {
    console.log(`[workspace] ${state.workspace}`);
    console.log(`[readonly] ${state.readonly}`);
    console.log(`[permissionMode] ${state.permissionMode}`);
    console.log(`[streaming] ${state.streaming}`);
    console.log(`[model] ${state.model}`);
    console.log(`[maxSteps] ${state.maxSteps}`);
    if (state.resumeFrom) {
      console.log(`[resume] ${state.resumeFrom} (${state.initialHistory?.length ?? 0} history items)`);
    }
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
      permissionMode: state.permissionMode,
      securityPolicy: state.securityPolicy,
      initialHistory: state.initialHistory,
      initialWorkflowState: state.initialWorkflowState,
      streaming: state.streaming,
      confirmToolCall: confirm ?? ((request) => confirmToolCall(request))
    });
    const finished = await finishSession(state.memoryDir, session, result.status === "failed" ? "failed" : "completed");
    await saveSessionSnapshot(state.memoryDir, finished, result.history, result.answer, result.workflowState);
    state.resumeFrom = finished.id;
    state.initialHistory = result.history;
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
  console.log(`${label("permissionMode")}: ${state.permissionMode}`);
  console.log(`${label("yes")}: ${state.yes}`);
  console.log(`${label("streaming")}: ${state.streaming}`);
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
  const typedMemories = await listMemories(memoryDir);
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
  console.log(`typedMemories: ${typedMemories.length}`);
  if (lastAction) {
    console.log(`lastAction: ${lastAction.timestamp} ${lastAction.toolName ?? "unknown"}`);
  }
  for (const memory of typedMemories.slice(0, 10)) {
    console.log(`- [${memory.type}] ${memory.name}: ${memory.description}`);
  }
}

async function printSessions(memoryDir: string): Promise<void> {
  const sessions = await listSessionSnapshots(memoryDir);
  if (sessions.length === 0) {
    console.log("No resumable sessions found.");
    return;
  }

  for (const session of sessions.slice(0, 20)) {
    const resumed = session.resumedFrom ? ` resumedFrom=${session.resumedFrom.slice(0, 8)}` : "";
    console.log(
      `${session.id.slice(0, 8)} ${session.status} history=${session.historyLength}${resumed} updated=${session.updatedAt} task=${session.userTask}`
    );
  }
}

async function applyResumeOption(state: CliState, resume: string | true): Promise<void> {
  const snapshot = resume === true ? await getLatestSessionSnapshot(state.memoryDir) : await loadSessionSnapshot(state.memoryDir, resume);
  if (!snapshot) {
    console.log(warning(resume === true ? "No previous session found." : `Session not found: ${resume}`));
    return;
  }
  applySessionSnapshot(state, snapshot);
  console.log(success(`Resumed session ${snapshot.metadata.id.slice(0, 8)} with ${snapshot.history.length} history items.`));
}

function applySessionSnapshot(state: CliState, snapshot: SessionSnapshot): void {
  state.resumeFrom = snapshot.metadata.id;
  state.initialHistory = snapshot.history;
  state.initialWorkflowState = snapshot.workflowState;
}

async function handlePlanCommand(
  line: string,
  state: CliState,
  confirm: (request: ToolConfirmationRequest) => Promise<boolean>
): Promise<void> {
  const action = line === "/plan" ? "status" : line.slice("/plan ".length).trim().toLowerCase();
  const planRunId = state.resumeFrom;

  if (action === "on") {
    state.permissionMode = "plan";
    state.readonly = true;
    console.log("Plan mode enabled. Ask the agent to inspect, writePlan, and exitPlanMode.");
    return;
  }

  if (action === "off" || action === "approve") {
    state.permissionMode = "default";
    state.readonly = false;
    console.log("Plan approved. Permission mode is now default.");
    return;
  }

  if (action === "manual") {
    state.permissionMode = "default";
    state.readonly = false;
    console.log("Plan kept for manual execution. Permission mode is now default.");
    return;
  }

  if (action === "execute") {
    if (!planRunId) {
      console.log(warning("No plan session is loaded. Use /resume <id> or run a plan task first."));
      return;
    }
    state.permissionMode = "default";
    state.readonly = false;
    const plan = await safeReadPlan(state.memoryDir, planRunId);
    const task = plan
      ? `Implement the approved plan from ${plan.path}.\n\n${plan.content}`
      : "Implement the approved plan from the resumed session.";
    await runSingleTask(task, state, confirm);
    return;
  }

  if (action === "status") {
    if (!planRunId) {
      console.log("No plan session is loaded yet.");
      return;
    }
    const plan = await safeReadPlan(state.memoryDir, planRunId);
    if (!plan) {
      console.log(`No plan file found for session ${planRunId.slice(0, 8)}.`);
      return;
    }
    console.log(label(`plan: ${plan.path}`));
    console.log(plan.content);
    return;
  }

  console.log("Usage: /plan [status|on|off|approve|execute|manual]");
}

async function safeReadPlan(memoryDir: string, runId: string): Promise<{ path: string; content: string } | undefined> {
  try {
    return await readPlanFile(memoryDir, runId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function printSkills(workspace: string): void {
  const skills = discoverSkills(workspace);
  if (skills.length === 0) {
    console.log("No skills found. Add .actlume/skills/<name>/SKILL.md.");
    return;
  }
  for (const skill of skills) {
    const invoke = skill.userInvocable ? `/${skill.name}` : skill.name;
    console.log(`${invoke} [${skill.context}:${skill.source}] - ${skill.description || "No description."}`);
  }
}

async function maybeInvokeSkillCommand(
  line: string,
  state: CliState,
  confirm: (request: ToolConfirmationRequest) => Promise<boolean>
): Promise<boolean> {
  const spaceIndex = line.indexOf(" ");
  const name = (spaceIndex === -1 ? line.slice(1) : line.slice(1, spaceIndex)).trim();
  const args = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1);
  const skill = getSkillByName(state.workspace, name);
  if (!skill || !skill.userInvocable) {
    return false;
  }
  const prompt = resolveSkillPrompt(skill, args);
  console.log(success(`Invoking skill: ${skill.name}`));
  await runSingleTask(prompt, state, confirm);
  return true;
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
  actlume                         Open the Pi-powered interactive terminal
  actlume --cwd D:\\workspace\\my-app
  actlume --readonly              Start the Pi terminal with read-only tools
  actlume --plan                   Start in read-only plan mode
  actlume --legacy                 Open the previous Actlume readline interface
  actlume "task"                 Start a task in the Pi TUI (RPC when non-interactive)
  actlume --cwd D:\\workspace\\my-app "task"
  actlume --readonly "inspect without modifying"
  actlume --max-steps 20 --model gpt-4.1-mini "task"
  actlume --mcp-config .agent-mcp.json "task"
  actlume --yes "task"
  actlume --plan "inspect and plan without writing"
  actlume --accept-edits "auto-approve file edits, still ask for execution"
  actlume --dont-ask "auto-deny actions that need confirmation"
  actlume --yolo "bypass confirmation prompts"
  actlume --stream "enable streaming on the legacy runtime"
  actlume --resume "resume the latest Actlume Pi session"
  actlume --resume <session-id> "resume a Pi session"
  actlume --json "task"       Run headless and emit one structured JSON result to stdout
  actlume --doctor            Check local runtime, storage, provider config, and MCP connections
  actlume --doctor --probe-provider  Send one minimal request to the configured OpenAI-compatible endpoint
  ma

Legacy interactive commands (use actlume --legacy):
  /help          Show this help
  /cwd           Print current workspace
  /cwd <path>    Switch workspace
  /status        Print workspace, model, readonly, and memory settings
  /tools         List available tools
  /mcp           Show MCP status
  /mcp tools     List MCP tools and schemas
  /mcp reload    Reload MCP servers from config
  /memory        Show memory counts
  /sessions      List resumable sessions
  /resume [id]   Resume latest or a specific session
  /plan status   Show the current resumed plan
  /plan on       Enable plan mode
  /plan approve  Leave plan mode after reviewing the plan
  /plan execute  Leave plan mode and ask the agent to implement the plan
  /plan manual   Leave plan mode and keep the plan for manual execution
  /skills        List available skills
  /<skill> args  Invoke a user-invocable skill
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
  /permission    Print permission mode
  /permission <default|plan|acceptEdits|dontAsk|bypassPermissions>
  /yes           Print auto-confirm flag
  /yes on        Enable auto-confirm flag
  /yes off       Disable auto-confirm flag
  /exit          Quit
`);
}

await main();
