import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type TSchema } from "typebox";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ExtensionToolContext,
  ExtensionUIContext,
  ToolCallEvent,
  ToolDefinition as PiToolDefinition
} from "@earendil-works/pi-coding-agent";
import { buildWorkspacePromptContext } from "./prompt.js";
import { buildContextPack, resolveInjectedContextBudget, type ContextPack } from "./context-budget.js";
import { mcpPiMigrationWarnings, readMcpConfig } from "./mcp-client.js";
import { buildRelevantMemoryContext, getUserMemoryDir, hasUserMemoryConsent, listMemories, promoteUserMemory, recallMemoriesDetailed, revokeUserMemoryConsent, setMemoryStatus } from "./memory.js";
import { formatLegacySessionImport, formatLegacySessionList } from "./legacy-session-import.js";
import { listSessionSnapshots, loadSessionSnapshot } from "./session.js";
import { appendRuntimeEvent, flushRuntimeTraceExporter, readRuntimeEvents, runtimeTraceExportDiagnostics, setRuntimeEventContext, type RuntimeEvent, type RuntimeStatus } from "./runtime-events.js";
import {
  assessTaskOutcome,
  captureWorkspaceSnapshot,
  checkEnvironmentId,
  createVerificationRecord,
  changedFilesSince,
  isVerificationCurrent,
  listVerificationRecords,
  loadCheckSpecs,
  matchCheckSpec,
  requiredCheckFilesAvailable,
  type CheckSpec,
  type WorkspaceSnapshot
} from "./verification.js";
import { runRegisteredTool } from "./tool-scheduler.js";
import { persistLargeObservation } from "./context-artifacts.js";
import { PiRunWorkflow } from "./pi-workflow.js";
import {
  branchIdentity,
  createTaskDomainEvent,
  extendTaskProjection,
  formatTaskContinuity,
  makeTaskOpenedEvent,
  makeTaskPromptEvent,
  reduceTaskBranch,
  taskDomainEntryType,
  workspaceIdentity,
  type PersistedTaskState,
  type PiEntryLike,
  type TaskDomainEvent,
  type TaskProjection
} from "./task-state.js";
import { isRuntimeTraceExportConfigured } from "./otel-exporter.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { resolveInsideCwd } from "./tools/path-utils.js";
import { acquireWorkspaceMutation } from "./workspace-coordinator.js";
import { classifyCompletionClaim } from "./completion-claim.js";
import { tools as actlumeTools } from "./tools/registry.js";
import { defaultPolicyConfig, getPolicyRule, policyConfigHash, type PolicyConfig } from "./policy-config.js";
import {
  assessShellCommand,
  checkToolPermission,
  isSensitivePath,
  isPlanModeAllowedWriteTool,
  shouldAutoApproveTool,
  shouldAutoDenyConfirmation
} from "./security.js";
import type { AppConfig } from "./config.js";
import type { PermissionMode, SecurityPolicy, ToolDefinition, ToolSideEffect } from "./types.js";

const compatibleProviderId = "actlume-compatible";
const bridgeConfigEnv = "ACTLUME_PI_BRIDGE_CONFIG";
const thisDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(thisDirectory, "..");
const piPackageEntrypoint = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piPackageRoot = resolve(dirname(piPackageEntrypoint), "..");
const piPackageMetadata = JSON.parse(readFileSync(resolve(piPackageRoot, "package.json"), "utf8")) as {
  bin?: Record<string, string> | string;
};
const piExecutable = typeof piPackageMetadata.bin === "string" ? piPackageMetadata.bin : piPackageMetadata.bin?.pi;
if (!piExecutable) throw new Error("The installed Pi package does not declare a `pi` executable.");
const piCliPath = resolve(piPackageRoot, piExecutable);

export type PiBridgeConfig = Pick<
  AppConfig,
  "workspace" | "memoryDir" | "readonly" | "permissionMode" | "model" | "baseURL" | "apiKey" | "mcpConfigPath" | "maxSteps" | "memoryEnabled" | "allowHeadlessCheckSpec"
> & {
  securityPolicy: SecurityPolicy;
  projectRoot: string;
  policyConfig?: PolicyConfig;
  memoryEnabled?: boolean;
  allowHeadlessCheckSpec?: boolean;
  allowedTools?: string[];
  maxToolCalls?: number;
  disableMcp?: boolean;
  agentId?: string;
  parentRunId?: string;
  subAgentDepth?: number;
};

export function resolvePiCliPath(): string {
  return piCliPath;
}

export function buildPiLaunchArgs(
  config: PiBridgeConfig,
  extensionPath = resolve(thisDirectory, "pi-extension.ts"),
  options: { sessionId?: string; prompt?: string } = {}
): string[] {
  // Pi normally discovers user/project extensions. Keep the host tool surface
  // reproducible: load only Actlume and the built-in MCP bridge explicitly.
  // In particular, scoped child sessions must not inherit ambient extensions.
  const args = [
    "--no-extensions",
    "--extension", extensionPath,
    "--extension", "builtin:mcp",
    "--no-builtin-tools",
    "--session-dir", resolve(config.memoryDir, "pi-sessions")
  ];
  if (config.baseURL) {
    args.push("--provider", compatibleProviderId, "--model", config.model);
  } else {
    const [provider, ...modelParts] = config.model.split("/");
    if (modelParts.length > 0) {
      args.push("--provider", provider, "--model", modelParts.join("/"));
    } else {
      args.push("--provider", "openai", "--model", config.model);
    }
  }

  if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.prompt) args.push("--", options.prompt);
  return args;
}

export async function launchPiInteractive(
  config: AppConfig,
  securityPolicy: SecurityPolicy,
  options: { sessionId?: string; prompt?: string } = {}
): Promise<number> {
  const bridgeConfig: PiBridgeConfig = {
    workspace: config.workspace,
    memoryDir: config.memoryDir,
    readonly: config.readonly,
    permissionMode: config.permissionMode,
    model: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    mcpConfigPath: config.mcpConfigPath,
    maxSteps: config.maxSteps,
    securityPolicy,
    projectRoot: packageRoot,
    policyConfig: config.policyConfig ?? defaultPolicyConfig,
    memoryEnabled: config.memoryEnabled,
    allowHeadlessCheckSpec: config.allowHeadlessCheckSpec
  };
  const env = {
    ...process.env,
    ...(config.apiKey ? { OPENAI_API_KEY: config.apiKey } : {}),
    [bridgeConfigEnv]: JSON.stringify(bridgeConfig)
  };
  const childArgs = [resolvePiCliPath(), ...buildPiLaunchArgs(bridgeConfig, undefined, options)];

  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(process.execPath, childArgs, {
      cwd: config.workspace,
      env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });
}

export type PiTaskResult = {
  schemaVersion: 1;
  sessionId: string;
  runId?: string;
  taskId?: string;
  runtimeStatus: RuntimeStatus | "unknown";
  evidenceStatus: string;
  taskVerdict: string;
  reason?: string;
  changedFiles: string[];
  verificationId?: string;
  exitCode: number;
};

export async function runPiTask(
  config: AppConfig,
  securityPolicy: SecurityPolicy,
  prompt: string,
  sessionId: string
): Promise<number> {
  return (await runPiTaskDetailed(config, securityPolicy, prompt, sessionId)).exitCode;
}

export async function runPiTaskDetailed(
  config: AppConfig,
  securityPolicy: SecurityPolicy,
  prompt: string,
  sessionId: string,
  options: { silent?: boolean } = {}
): Promise<PiTaskResult> {
  const bridgeConfig: PiBridgeConfig = {
    workspace: config.workspace,
    memoryDir: config.memoryDir,
    readonly: config.readonly,
    permissionMode: config.permissionMode,
    model: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    mcpConfigPath: config.mcpConfigPath,
    maxSteps: config.maxSteps,
    securityPolicy,
    projectRoot: packageRoot,
    policyConfig: config.policyConfig ?? defaultPolicyConfig,
    memoryEnabled: config.memoryEnabled,
    allowHeadlessCheckSpec: config.allowHeadlessCheckSpec
  };
  const args = buildPiLaunchArgs(bridgeConfig, undefined, { sessionId });
  const client = new RpcClient({
    cliPath: resolvePiCliPath(),
    cwd: config.workspace,
    env: {
      ...process.env,
      ...(config.apiKey ? { OPENAI_API_KEY: config.apiKey } : {}),
      [bridgeConfigEnv]: JSON.stringify(bridgeConfig)
    },
    args
  });
  let streamedText = false;
  const unsubscribe = client.onEvent((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      streamedText = true;
      if (!options.silent) process.stdout.write(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      process.stderr.write(`\n[tool] ${event.toolName}\n`);
    } else if (event.type === "tool_execution_end" && event.isError) {
      process.stderr.write(`[tool error] ${event.toolName}\n`);
    }
  });

  try {
    await client.start();
    const events = await client.promptAndWait(prompt, undefined, 30 * 60_000);
    if (!streamedText) {
      const answer = await client.getLastAssistantText();
      if (answer && !options.silent) process.stdout.write(answer);
    } else {
      if (!options.silent) process.stdout.write("\n");
    }
    const finalAssistant = [...events].reverse().find((event) =>
      event.type === "message_end" && (event.message as { role?: string }).role === "assistant"
    );
    const stopReason = finalAssistant && finalAssistant.type === "message_end"
      ? (finalAssistant.message as { stopReason?: string }).stopReason
      : undefined;
    const recorded = await readRuntimeEvents(config.memoryDir, sessionId);
    const finished = [...recorded].reverse().find((event) => event.kind === "run_finished");
    const runtimeStatus = finished?.status ?? (stopReason === "aborted" ? "cancelled" : stopReason === "error" ? "failed" : "unknown");
    const evidenceStatus = typeof finished?.attributes?.evidenceStatus === "string" ? finished.attributes.evidenceStatus : "unknown";
    const taskVerdict = typeof finished?.attributes?.taskVerdict === "string" ? finished.attributes.taskVerdict : "unjudged";
    const changedFiles = Array.isArray(finished?.attributes?.changedFiles)
      ? finished.attributes.changedFiles.filter((path): path is string => typeof path === "string")
      : [];
    const approvalRequired = recorded.some((event) => event.kind === "policy_decision" && event.outcome === "block"
      && event.policyId === "permission-policy-v1" && typeof event.attributes?.reason === "string"
      && /interactive approval is required|denied a confirmation|required/i.test(event.attributes.reason));
    const exitCode = runtimeStatus === "budget_exhausted" ? 2
      : runtimeStatus === "cancelled" || runtimeStatus === "interrupted" ? 130
        : approvalRequired ? 3
          : runtimeStatus === "failed" || evidenceStatus === "checks_failed" || !finished ? 1 : 0;
    return {
      schemaVersion: 1,
      sessionId,
      runId: finished?.runId,
      taskId: finished?.taskId,
      runtimeStatus,
      evidenceStatus,
      taskVerdict,
      reason: typeof finished?.attributes?.taskOutcomeReason === "string" ? finished.attributes.taskOutcomeReason : undefined,
      changedFiles,
      verificationId: typeof finished?.attributes?.verificationId === "string" && finished.attributes.verificationId ? finished.attributes.verificationId : undefined,
      exitCode
    };
  } finally {
    unsubscribe();
    await client.stop();
  }
}

export function createActlumePiExtension(config: PiBridgeConfig): ExtensionFactory {
  return async (pi) => {
    setRuntimeEventContext(config.memoryDir, {
      agentId: config.agentId ?? "main",
      parentRunId: config.parentRunId
    });
    let activeRunId = randomUUID();
    let selectedMemoryFiles: string[] = [];
    let activeRunStatus: RuntimeStatus = "running";
    let cancellationEventLogged = false;
    let activeTurnCount = 0;
    let activeStopReason: string | undefined;
    let activeSessionId = "";
    let activeBaseline: WorkspaceSnapshot | undefined;
    let activeAssessment: ReturnType<typeof assessTaskOutcome> | undefined;
    let activeTaskProjection: TaskProjection = { issues: [] };
    let activeTaskState: PersistedTaskState | undefined;
    let activeTaskId: string | undefined;
    let activeBranchId: string | undefined;
    const activeWorkspaceId = workspaceIdentity(config.workspace);
    let activeContextBudget: ContextPack | undefined;
    let mcpCompatibilityWarnings: string[] = [];
    let reportedTraceDrops = 0;
    let activeTask = "";
    let activeWorkflow = new PiRunWorkflow(activeRunId);
    let verificationNudgeIssued = false;
    const toolStartedAt = new Map<string, number>();
    let modelStartedAt: number | undefined;
    const memoryEnabled = config.memoryEnabled !== false;
    const scopedToolNames = config.allowedTools ? new Set(config.allowedTools) : undefined;
    const localTools = actlumeTools.filter((tool) =>
      tool.name !== "agent" && (!scopedToolNames || scopedToolNames.has(tool.name))
    );
    const localToolsByName = new Map(localTools.map((tool) => [tool.name, tool]));
    let activeToolCallCount = 0;

    function projectionForContext(ctx: Pick<ExtensionContext, "sessionManager">): TaskProjection {
      const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
        getBranch?: (fromId?: string) => PiEntryLike[];
        getLeafId?: () => string | null;
      };
      if (typeof sessionManager.getBranch !== "function") {
        if (activeTaskState?.workspaceId === activeWorkspaceId && activeTaskState.status === "active") return { active: activeTaskState, latest: activeTaskState, issues: activeTaskProjection.issues };
        return { issues: ["The Pi session manager cannot expose the active branch for task recovery."] };
      }
      const leafId = sessionManager.getLeafId?.();
      return reduceTaskBranch(sessionManager.getBranch(leafId ?? undefined), activeWorkspaceId);
    }

    function leafIdForContext(ctx: Pick<ExtensionContext, "sessionManager">): string | null {
      const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & { getLeafId?: () => string | null };
      return sessionManager.getLeafId?.() ?? null;
    }

    function appendTaskEvent(ctx: Pick<ExtensionContext, "sessionManager">, event: TaskDomainEvent): PersistedTaskState | undefined {
      const piWithAppend = pi as ExtensionAPI & { appendEntry?: (customType: string, data: unknown) => unknown };
      piWithAppend.appendEntry?.(taskDomainEntryType, event);
      const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
        getBranch?: (fromId?: string) => PiEntryLike[];
        getLeafId?: () => string | null;
      };
      const branch = typeof sessionManager.getBranch === "function"
        ? sessionManager.getBranch(sessionManager.getLeafId?.() ?? undefined)
        : [];
      const alreadyVisible = branch.some((entry) =>
        entry.type === "custom" && entry.customType === taskDomainEntryType
        && typeof entry.data === "object" && entry.data !== null
        && (entry.data as { eventId?: unknown }).eventId === event.eventId
      );
      activeTaskProjection = alreadyVisible
        ? reduceTaskBranch(branch, activeWorkspaceId)
        : extendTaskProjection(activeTaskProjection, event);
      activeTaskState = activeTaskProjection.active ?? activeTaskProjection.latest;
      return activeTaskState;
    }

    function persistWorkflowSnapshot(ctx: Pick<ExtensionContext, "sessionManager">): void {
      if (!activeTaskState || activeTaskState.status !== "active") return;
      const event = createTaskDomainEvent({
        kind: "workflow_snapshot",
        workspaceId: activeWorkspaceId,
        sessionId: activeSessionId,
        taskId: activeTaskState.taskId,
        branchId: activeTaskState.branchId,
        runId: activeRunId,
        payload: { workflow: activeWorkflow.snapshot() }
      });
      appendTaskEvent(ctx, event);
    }

    if (config.baseURL) {
      pi.registerProvider(compatibleProviderId, {
        name: "Actlume OpenAI-compatible endpoint",
        baseUrl: config.baseURL,
        apiKey: config.apiKey ? config.apiKey : "$OPENAI_API_KEY",
        api: "openai-completions",
        models: [
          {
            id: config.model,
            name: `${config.model} (Actlume endpoint; pricing unknown)`,
            api: "openai-completions",
            input: ["text", "image"],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192
          }
        ]
      });
    }

    if (!config.disableMcp) {
      const { config: mcpConfig } = await readMcpConfig({
        workspace: config.workspace,
        projectRoot: config.projectRoot,
        configPath: config.mcpConfigPath
      });
      mcpCompatibilityWarnings = mcpPiMigrationWarnings(mcpConfig);
      for (const [name, server] of Object.entries(mcpConfig.servers)) {
        pi.registerMcpServer(name, {
          type: "stdio",
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd,
          enabled: !server.disabled,
          exposure: "direct",
          timeout: Math.ceil(server.toolTimeoutMs / 1_000)
        });
      }
    }

    pi.on("before_agent_start", async (event, ctx) => {
      activeRunId = randomUUID();
      activeRunStatus = "running";
      cancellationEventLogged = false;
      activeTurnCount = 0;
      activeStopReason = undefined;
      activeAssessment = undefined;
      activeContextBudget = undefined;
      verificationNudgeIssued = false;
      activeToolCallCount = 0;
      const sessionId = ctx.sessionManager.getSessionId();
      activeSessionId = sessionId;
      const branch = projectionForContext(ctx);
      activeTaskProjection = branch;
      let taskState = branch.active;
      if (!taskState && activeTaskState?.status === "active" && activeTaskState.workspaceId === activeWorkspaceId
        && activeTaskState.sessionId === sessionId) taskState = activeTaskState;
      if (taskState && taskState.latestRunStatus === "running") {
        const interrupted = createTaskDomainEvent({
          kind: "run_interrupted", workspaceId: activeWorkspaceId, sessionId, taskId: taskState.taskId,
          branchId: taskState.branchId, runId: taskState.latestRunId,
          payload: { reason: "A new user turn arrived before the previous task run had a settled record." }
        });
        taskState = appendTaskEvent(ctx, interrupted);
      }
      const currentLeafId = leafIdForContext(ctx);
      if (taskState?.status === "active" && taskState.sessionId !== sessionId) {
        const forked = createTaskDomainEvent({
          kind: "task_branch", workspaceId: activeWorkspaceId, sessionId, taskId: taskState.taskId,
          branchId: branchIdentity(activeWorkspaceId, sessionId, currentLeafId),
          payload: { parentSessionId: taskState.sessionId, parentBranchId: taskState.branchId, leafId: currentLeafId ?? "" }
        });
        taskState = appendTaskEvent(ctx, forked);
      }
      if (taskState?.status !== "active") {
        const baseline = await captureWorkspaceSnapshot(config.workspace, [config.memoryDir]);
        const opened = makeTaskOpenedEvent({
          workspaceId: activeWorkspaceId,
          sessionId,
          branchId: branchIdentity(activeWorkspaceId, sessionId, currentLeafId),
          prompt: event.prompt,
          baseline,
          entryId: currentLeafId ?? undefined
        });
        taskState = appendTaskEvent(ctx, opened);
      } else {
        const promptEvent = makeTaskPromptEvent(taskState, event.prompt, currentLeafId ?? undefined);
        taskState = appendTaskEvent(ctx, promptEvent);
      }
      if (!taskState || !taskState.baseline) {
        const reason = "Actlume could not write or restore task state on the active Pi branch.";
        if (ctx.mode === "tui") ctx.ui.notify(reason, "error");
        throw new Error(reason);
      }
      activeTaskState = taskState;
      activeTaskId = taskState.taskId;
      activeBranchId = taskState.branchId;
      activeTaskProjection = { active: taskState, latest: taskState, issues: branch.issues };
      activeBaseline = taskState.baseline;
      activeTask = formatTaskContinuity(taskState, event.prompt);
      activeWorkflow = taskState.workflow
        ? PiRunWorkflow.fromSnapshot(activeRunId, taskState.workflow)
        : new PiRunWorkflow(activeRunId);
      const sessionFile = ctx.sessionManager.getSessionFile();
      await appendRuntimeEvent(config.memoryDir, {
        kind: "session_started",
        workspace: config.workspace,
        sessionId,
        status: "idle",
        attributes: { sessionFile: sessionFile ?? "" }
      });
      for (const detail of mcpCompatibilityWarnings) {
        await appendRuntimeEvent(config.memoryDir, {
          kind: "policy_decision", workspace: config.workspace, sessionId, runId: activeRunId,
          taskId: taskState.taskId, branchId: taskState.branchId, outcome: "warn",
          policyId: "mcp-config-migration-v1", reasonCode: "PI_SETTING_NOT_MAPPED", attributes: { detail }
        });
      }
      if (ctx.mode === "tui" && mcpCompatibilityWarnings.length > 0) {
        ctx.ui.notify(`MCP compatibility notes:\n${mcpCompatibilityWarnings.join("\n")}`, "warning");
      }
      if (ctx.mode === "tui") ctx.ui.setStatus("actlume-task", "running · outcome not yet assessed");
      await appendRuntimeEvent(config.memoryDir, {
        kind: "run_started",
        workspace: config.workspace,
        sessionId,
        runId: activeRunId,
        taskId: taskState.taskId,
        branchId: taskState.branchId,
        status: "running",
        attributes: {
          policyConfigHash: policyConfigHash(config.policyConfig),
          policyRules: JSON.stringify([
            getPolicyRule(config.policyConfig, "actlume.workflow.efficiency"),
            getPolicyRule(config.policyConfig, "actlume.task.scope-precheck")
          ].map(({ id, version, layer, mode }) => ({ id, version, layer, mode }))),
          memoryTreatment: memoryEnabled ? "enabled" : "disabled",
          headlessCheckSpecAutoapproval: config.allowHeadlessCheckSpec === true
        }
      });
      appendTaskEvent(ctx, createTaskDomainEvent({
        kind: "run_started", workspaceId: activeWorkspaceId, sessionId, taskId: taskState.taskId,
        branchId: taskState.branchId, runId: activeRunId
      }));
      persistWorkflowSnapshot(ctx);
      const workspaceContext = buildWorkspacePromptContext(config.workspace, {
        includeSkills: false,
        includeSubAgents: false
      });
      const memoryRecall = memoryEnabled
        ? await recallMemoriesDetailed(config.memoryDir, event.prompt, 5, config.workspace, {
            taskId: taskState.taskId,
            sessionId,
            branchId: taskState.branchId
          })
        : { memories: [], selected: [], rejected: [] };
      const memories = memoryRecall.memories;
      selectedMemoryFiles = memories.map((memory) => memory.filename);
      const allMemories = memoryEnabled ? await listMemories(config.memoryDir) : [];
      const selectedSet = new Set(selectedMemoryFiles);
      const rejectedMemories = [
        ...memoryRecall.rejected.map((memory) => `${memory.filename}:${memory.reason}`),
        ...allMemories.filter((memory) => !selectedSet.has(memory.filename) && !memoryRecall.rejected.some((rejected) => rejected.filename === memory.filename))
          .map((memory) => `${memory.filename}:${memory.status ?? "needs_review"}`)
      ];
      await appendRuntimeEvent(config.memoryDir, {
        kind: "memory_retrieved",
        workspace: config.workspace,
        sessionId,
        runId: activeRunId,
        attributes: {
          retrievalSource: "context",
          selected: memoryRecall.selected.map((memory) => `${memory.filename}:${memory.reason}`),
          rejected: rejectedMemories,
          memoryTreatment: memoryEnabled ? "enabled" : "disabled",
          ...(memoryEnabled ? {} : { reasonCode: "MEMORY_TREATMENT_DISABLED" })
        }
      });
      const memoryContext = buildRelevantMemoryContext(memories);
      const memoryGuidance = memoryEnabled ? [
        "## Evidence-aware memory use",
        "Treat recalled memories as fallible context and check scope and applicability before relying on them.",
        "Only save reusable project constraints, verified commands, or durable feedback as candidate memories; never store temporary task progress or secrets. Include source references and affected paths when using memorySave."
      ].join("\n") : "";
      const taskContext = `## Active task continuity\n${formatTaskContinuity(taskState, event.prompt)}`;
      const contextBudget = resolveInjectedContextBudget(ctx.model?.contextWindow);
      const contextPack = buildContextPack([taskContext, workspaceContext, memoryGuidance].filter(Boolean).join("\n\n"), memoryContext, contextBudget.maxTokens);
      const finalSystemContext = `${event.systemPrompt}\n\n${contextPack.text}`;
      const systemContextHash = hashAttribution(finalSystemContext);
      const taskInputHash = hashAttribution(event.prompt);
      const treatmentConfigHash = hashAttribution(JSON.stringify({
        policyConfigHash: policyConfigHash(config.policyConfig),
        memoryTreatment: memoryEnabled ? "enabled" : "disabled",
        selectedMemoryFiles: selectedMemoryFiles.slice().sort(),
        memoryContextHash: hashAttribution(memoryContext)
      }));
      activeContextBudget = contextPack;
      await appendRuntimeEvent(config.memoryDir, {
        kind: "context_budget_decision",
        workspace: config.workspace,
        sessionId,
        runId: activeRunId,
        outcome: contextPack.truncated ? "warn" : "allow",
        policyId: "actlume-context-budget-v1",
        reasonCode: contextPack.truncated ? "INJECTED_CONTEXT_TRUNCATED" : "INJECTED_CONTEXT_WITHIN_BUDGET",
        attributes: {
          estimatedTokens: contextPack.usedTokens,
          budgetTokens: contextPack.maxTokens,
          remainingTokens: contextPack.remainingTokens,
          budgetSource: contextBudget.source,
          tokenEstimator: "characters_divided_by_4",
          ...(typeof ctx.model?.contextWindow === "number" ? { modelContextWindow: ctx.model.contextWindow } : {}),
          sourceChars: contextPack.sourceChars,
          includedChars: contextPack.text.length,
          truncated: contextPack.truncated,
          selectedMemoryCount: memories.length,
          taskInputHash,
          injectedContextHash: hashAttribution(contextPack.text),
          systemContextHash,
          treatmentConfigHash
        }
      });
      const actlumeContext = contextPack.text;
      if (!actlumeContext) return;
      return { systemPrompt: finalSystemContext };
    });

    for (const tool of localTools) registerActlumeTool(pi, tool, config, () => ({
      runId: activeRunId,
      sessionId: activeSessionId,
      taskId: activeTaskId,
      branchId: activeBranchId,
      requirementRevision: activeTaskState?.requirementRevision,
      baseline: activeBaseline,
      workflow: activeWorkflow,
      appendTaskEvent
    }));
    if (!config.allowedTools && (config.subAgentDepth ?? 0) < 1) {
      registerScopedResearchTool(pi, config, () => ({
        runId: activeRunId,
        sessionId: activeSessionId,
        selectedMemoryFiles,
        workflow: activeWorkflow
      }));
    }

    pi.on("tool_call", async (event, ctx) => {
      activeToolCallCount += 1;
      await appendRuntimeEvent(config.memoryDir, {
        kind: "tool_requested", workspace: config.workspace, sessionId: activeSessionId,
        runId: activeRunId, taskId: activeTaskId, branchId: activeBranchId,
        toolCallId: event.toolCallId, toolName: event.toolName
      });
      if (config.maxToolCalls !== undefined && activeToolCallCount > config.maxToolCalls) {
        const reason = "Scoped sub-agent tool-call budget exhausted; return the evidence collected so far.";
        await appendRuntimeEvent(config.memoryDir, {
          kind: "policy_decision", workspace: config.workspace, sessionId: activeSessionId, runId: activeRunId,
          toolCallId: event.toolCallId, toolName: event.toolName, outcome: "block", policyId: "subagent-budget-v1",
          reasonCode: "TOOL_CALL_BUDGET_EXHAUSTED", agentId: config.agentId ?? "main", parentRunId: config.parentRunId,
          attributes: { maxToolCalls: config.maxToolCalls }
        });
        return { block: true, reason };
      }
      const permissionDecision = await enforceActlumePolicy(event, ctx.ui, ctx.mode, config, localToolsByName, ctx.signal, {
        sessionId: activeSessionId,
        runId: activeRunId,
        taskId: activeTaskId,
        branchId: activeBranchId
      });
      if (permissionDecision) {
        await appendRuntimeEvent(config.memoryDir, {
          kind: "policy_decision", workspace: config.workspace, sessionId: activeSessionId, runId: activeRunId,
          toolCallId: event.toolCallId, toolName: event.toolName, outcome: "block", policyId: "permission-policy-v1",
          reasonCode: ctx.signal?.aborted ? "APPROVAL_CANCELLED" : "PERMISSION_BLOCKED", attributes: { reason: permissionDecision.reason }
        });
        activeWorkflow.record(event.toolName, event.input, { isError: true, content: permissionDecision.reason, details: { errorCode: "PERMISSION_BLOCKED" } }, event.toolCallId);
        return permissionDecision;
      }
      const guardFailure = activeWorkflow.check(event.toolName, event.input, activeTask, config.maxSteps ?? 40, event.toolCallId, activeTurnCount, config.policyConfig);
      const taskSpecificError = guardFailure?.ok === false && isTaskSpecificPolicyError(guardFailure.errorCode);
      const policyRule = getPolicyRule(config.policyConfig, taskSpecificError ? "actlume.task.scope-precheck" : "actlume.workflow.efficiency");
      const observedBlock = guardFailure?.ok === false && policyRule.mode === "observe";
      await appendRuntimeEvent(config.memoryDir, {
        kind: "policy_decision", workspace: config.workspace, sessionId: activeSessionId, runId: activeRunId,
        toolCallId: event.toolCallId, toolName: event.toolName,
        outcome: guardFailure?.ok === false ? observedBlock ? "warn" : "block" : "allow",
        policyId: policyRule.id,
        reasonCode: guardFailure?.ok === false
          ? observedBlock ? `WOULD_BLOCK_${guardFailure.errorCode}` : guardFailure.errorCode
          : policyRule.mode === "disabled" ? "POLICY_DISABLED" : "WORKFLOW_ALLOWED",
        attributes: {
          step: activeWorkflow.history.length + 1,
          policyVersion: policyRule.version,
          policyLayer: policyRule.layer,
          policyMode: policyRule.mode,
          reason: guardFailure?.content ?? "Workflow policy allowed this action."
        }
      });
      if (guardFailure?.ok === false && !observedBlock) {
        activeWorkflow.record(event.toolName, event.input, {
          isError: true, content: guardFailure.content, details: { errorCode: guardFailure.errorCode }
        }, event.toolCallId);
        return { block: true, reason: guardFailure.content };
      }
    });

    pi.on("tool_execution_start", async (event, ctx) => {
      toolStartedAt.set(event.toolCallId, Date.now());
      await appendRuntimeEvent(config.memoryDir, {
        kind: "tool_started",
        workspace: config.workspace,
        sessionId: ctx.sessionManager.getSessionId(),
        runId: activeRunId,
        taskId: activeTaskId,
        branchId: activeBranchId,
        toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId,
        toolName: event.toolName
      });
      if (activeTaskId && activeBranchId) {
        appendTaskEvent(ctx, createTaskDomainEvent({
          kind: "tool_started", workspaceId: activeWorkspaceId, sessionId: activeSessionId,
          taskId: activeTaskId, branchId: activeBranchId, runId: activeRunId,
          toolCallId: event.toolCallId, toolName: event.toolName,
          payload: { parentToolCallId: event.parentToolCallId ?? "" }
        }));
      }
    });

    pi.on("turn_start", (_event, ctx) => {
      activeTurnCount += 1;
      if (config.maxSteps && activeTurnCount > config.maxSteps) {
        activeRunStatus = "budget_exhausted";
        ctx.abort();
      }
    });

    pi.on("agent_start", (_event, ctx) => {
      const signal = ctx.signal;
      if (!signal) return;
      const recordCancellation = () => {
        if (cancellationEventLogged) return;
        cancellationEventLogged = true;
        activeRunStatus = "cancelling";
        void appendRuntimeEvent(config.memoryDir, {
          kind: "run_cancelling", workspace: config.workspace, sessionId: activeSessionId,
          runId: activeRunId, taskId: activeTaskId, branchId: activeBranchId,
          status: "cancelling", reasonCode: "PI_ABORT_SIGNAL_RECEIVED"
        });
      };
      if (signal.aborted) recordCancellation();
      else signal.addEventListener("abort", recordCancellation, { once: true });
    });

    pi.on("agent_end", async (event, ctx) => {
      const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant") as { stopReason?: string; content?: unknown } | undefined;
      if (lastAssistant?.stopReason) activeStopReason = lastAssistant.stopReason;
      const text = extractAssistantText(lastAssistant?.content);
      const claim = lastAssistant?.stopReason === "stop"
        ? classifyCompletionClaim(text)
        : { status: "unknown" as const, evidence: "assistant_did_not_finish_normally", preview: text.slice(0, 300) };
      await appendRuntimeEvent(config.memoryDir, {
        kind: "completion_claim", workspace: config.workspace, sessionId: activeSessionId,
        runId: activeRunId, taskId: activeTaskId, branchId: activeBranchId,
        attributes: { claimStatus: claim.status, evidence: claim.evidence, preview: claim.preview }
      });
      if (activeTaskId && activeBranchId) {
        appendTaskEvent(ctx, createTaskDomainEvent({
          kind: "completion_claim", workspaceId: activeWorkspaceId, sessionId: activeSessionId,
          taskId: activeTaskId, branchId: activeBranchId, runId: activeRunId,
          payload: { status: claim.status, evidence: claim.evidence, preview: claim.preview }
        }));
      }
    });

    pi.on("agent_before_settle", async (event) => {
      if (event.outcome !== "completed" || verificationNudgeIssued || !activeBaseline?.fingerprint) return;
      const current = await captureWorkspaceSnapshot(config.workspace, [config.memoryDir]);
      const changedFiles = changedFilesSince(activeBaseline, current);
      if (changedFiles.length === 0) return;
      const checks = await listVerificationRecords(config.memoryDir, activeSessionId);
      const checkSpecs = await loadCheckSpecs(config.workspace).catch(() => []);
      const environmentIds = await Object.fromEntries(await Promise.all(checkSpecs.map(async (spec) => [
        spec.id, await checkEnvironmentId(config.workspace, spec)
      ] as const)));
      const requiredSpecs = checkSpecs.filter((spec) => spec.required);
      const hasCurrentCheck = requiredSpecs.length > 0 && requiredSpecs.every((spec) => checks.some((record) =>
        record.runId === activeRunId && record.taskId === activeTaskId && record.specId === spec.id
        && isVerificationCurrent(record, current) && record.environmentId === environmentIds[spec.id]
      ));
      if (hasCurrentCheck) return;
      verificationNudgeIssued = true;
      await appendRuntimeEvent(config.memoryDir, {
        kind: "policy_decision", workspace: config.workspace, sessionId: activeSessionId, runId: activeRunId,
        outcome: "warn", policyId: "completion-evidence-v1", reasonCode: "CHANGES_WITHOUT_CURRENT_VERIFICATION",
        attributes: { changedFiles, requiredCheckCount: requiredSpecs.length }
      });
      return {
        entries: [{
          type: "custom_message",
          customType: "actlume_verification_nudge",
          content: (requiredSpecs.length === 0
            ? "Workspace changes exist but this project has no valid required CheckSpec configuration. Do not call a free-form command match trusted check evidence. "
            : "Workspace changes exist without all required CheckSpec checks passing for the current content: ")
            + changedFiles.join(", ") + ". Run the configured checks if possible. If verification is unavailable or the task is intentionally unverified, say so clearly; do not claim accepted success.",
          display: false
        }],
        continue: true
      };
    });

    pi.on("tool_execution_end", async (event, ctx) => {
      const startedAt = toolStartedAt.get(event.toolCallId);
      toolStartedAt.delete(event.toolCallId);
      await appendRuntimeEvent(config.memoryDir, {
        kind: "tool_finished",
        workspace: config.workspace,
        sessionId: ctx.sessionManager.getSessionId(),
        runId: activeRunId,
        taskId: activeTaskId,
        branchId: activeBranchId,
        toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId,
        toolName: event.toolName,
        durationMs: startedAt === undefined ? undefined : Date.now() - startedAt,
        error: event.isError
      });
      if (activeTaskId && activeBranchId) {
        appendTaskEvent(ctx, createTaskDomainEvent({
          kind: "tool_finished", workspaceId: activeWorkspaceId, sessionId: activeSessionId,
          taskId: activeTaskId, branchId: activeBranchId, runId: activeRunId,
          toolCallId: event.toolCallId, toolName: event.toolName,
          payload: { isError: event.isError }
        }));
        persistWorkflowSnapshot(ctx);
      }
    });

    pi.on("message_start", (event) => {
      const message = event.message as { role?: string };
      if (message.role === "assistant") modelStartedAt = Date.now();
    });

    pi.on("message_end", async (event, ctx) => {
      const message = event.message as {
        role?: string;
        model?: string;
        provider?: string;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      };
      if (message.role !== "assistant" || !message.usage) return;
      const reportedUsage = [message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite]
        .some((value) => typeof value === "number" && value > 0);
      await appendRuntimeEvent(config.memoryDir, {
        kind: "model_usage",
        workspace: config.workspace,
        sessionId: ctx.sessionManager.getSessionId(),
        runId: activeRunId,
        usage: reportedUsage ? {
          input: message.usage.input,
          output: message.usage.output,
          cacheRead: message.usage.cacheRead,
          cacheWrite: message.usage.cacheWrite
        } : undefined,
        durationMs: modelStartedAt === undefined ? undefined : Date.now() - modelStartedAt,
        attributes: {
          ...(message.model ? { modelId: message.model } : {}),
          ...(message.provider ? { provider: message.provider } : {})
        }
      });
      modelStartedAt = undefined;
    });

    pi.on("agent_settled", async (_event, ctx) => {
      const current = await captureWorkspaceSnapshot(config.workspace, [config.memoryDir]);
      const verificationRecords = await listVerificationRecords(config.memoryDir, ctx.sessionManager.getSessionId());
      const checkSpecs = await loadCheckSpecs(config.workspace).catch(async (error) => {
        await appendRuntimeEvent(config.memoryDir, {
          kind: "policy_decision", workspace: config.workspace, sessionId: ctx.sessionManager.getSessionId(),
          runId: activeRunId, taskId: activeTaskId, branchId: activeBranchId,
          outcome: "warn", policyId: "check-spec-v1", reasonCode: "CHECK_CONFIG_INVALID",
          attributes: { reason: (error as Error).message }
        });
        return [];
      });
      const currentEnvironmentIds = Object.fromEntries(await Promise.all(checkSpecs.map(async (spec) => [
        spec.id, await checkEnvironmentId(config.workspace, spec)
      ] as const)));
      if (activeRunStatus === "running" || activeRunStatus === "cancelling") {
        if (activeStopReason === "aborted") activeRunStatus = "cancelled";
        else if (activeStopReason === "error") activeRunStatus = "failed";
        else activeRunStatus = "completed";
      }
      const assessment = activeBaseline
        ? assessTaskOutcome({
            baseline: activeBaseline,
            current,
            verifications: verificationRecords,
            runId: activeRunId,
            taskId: activeTaskId,
            requirementRevision: activeTaskState?.requirementRevision,
            checkSpecs,
            currentEnvironmentIds
          })
        : { evidenceStatus: "unknown" as const, taskVerdict: "unjudged" as const, reason: "Task-start workspace baseline is unavailable.", changedFiles: [] };
      await appendRuntimeEvent(config.memoryDir, {
        kind: "run_finished",
        workspace: config.workspace,
        sessionId: ctx.sessionManager.getSessionId(),
        runId: activeRunId,
        taskId: activeTaskId,
        branchId: activeBranchId,
        status: activeRunStatus,
        attributes: {
          selectedMemoryCount: selectedMemoryFiles.length,
          turns: activeTurnCount,
          evidenceStatus: assessment.evidenceStatus,
          taskVerdict: assessment.taskVerdict,
          taskOutcomeReason: assessment.reason,
          changedFiles: assessment.changedFiles,
          verificationId: assessment.verificationId ?? "",
          stopReason: activeStopReason ?? "unknown"
        }
      });
      activeAssessment = assessment;
      if (activeTaskId && activeBranchId) {
        const verificationId = assessment.verificationId;
        if (verificationId) {
          appendTaskEvent(ctx, createTaskDomainEvent({
            kind: "verification", workspaceId: activeWorkspaceId, sessionId: activeSessionId,
            taskId: activeTaskId, branchId: activeBranchId, runId: activeRunId,
            payload: { verificationId, evidenceStatus: assessment.evidenceStatus, taskVerdict: assessment.taskVerdict, reason: assessment.reason }
          }));
        }
        appendTaskEvent(ctx, createTaskDomainEvent({
          kind: "run_finished", workspaceId: activeWorkspaceId, sessionId: activeSessionId,
          taskId: activeTaskId, branchId: activeBranchId, runId: activeRunId,
          payload: { runtimeStatus: activeRunStatus, assessment }
        }));
        persistWorkflowSnapshot(ctx);
      }
      if (ctx.mode === "tui") {
        ctx.ui.setStatus("actlume-task", `${activeRunStatus} · ${assessment.evidenceStatus} · ${assessment.taskVerdict}`);
      }
      await flushRuntimeTraceExporter();
      const traceDiagnostics = runtimeTraceExportDiagnostics();
      if (ctx.mode === "tui" && traceDiagnostics && traceDiagnostics.dropped > reportedTraceDrops) {
        const newlyDropped = traceDiagnostics.dropped - reportedTraceDrops;
        ctx.ui.notify(`OTLP trace exporter dropped ${newlyDropped} span batch(es); ${traceDiagnostics.dropped} dropped total. Local JSONL remains available.`, "warning");
      }
      reportedTraceDrops = traceDiagnostics?.dropped ?? reportedTraceDrops;
    });

    pi.on("session_start", async (_event, ctx) => {
      activeSessionId = ctx.sessionManager.getSessionId();
      activeTaskProjection = projectionForContext(ctx);
      activeTaskState = activeTaskProjection.active ?? activeTaskProjection.latest;
      activeBaseline = activeTaskState?.baseline;
      activeAssessment = activeTaskState?.lastAssessment;
      if (activeTaskState?.latestRunStatus) {
        activeRunStatus = activeTaskState.latestRunStatus === "unknown" ? "idle" : activeTaskState.latestRunStatus;
      }
      if (activeTaskState?.status === "active") {
        activeTaskId = activeTaskState.taskId;
        activeBranchId = activeTaskState.branchId;
        activeTask = formatTaskContinuity(activeTaskState, "");
        activeWorkflow = activeTaskState.workflow
          ? PiRunWorkflow.fromSnapshot(activeTaskState.latestRunId ?? randomUUID(), activeTaskState.workflow)
          : new PiRunWorkflow(activeTaskState.latestRunId ?? randomUUID());
      }
      const priorEvents = await readRuntimeEvents(config.memoryDir, ctx.sessionManager.getSessionId());
      const startedRuns = priorEvents.filter((event) => event.kind === "run_started" && event.runId);
      const finishedRunIds = new Set(priorEvents
        .filter((event) => event.kind === "run_finished" || event.kind === "run_interrupted")
        .flatMap((event) => event.runId ? [event.runId] : []));
      const interruptedRuns = startedRuns.filter((event) => event.runId && !finishedRunIds.has(event.runId));
      for (const priorRun of interruptedRuns) {
        await appendRuntimeEvent(config.memoryDir, {
          kind: "run_interrupted",
          workspace: config.workspace,
          sessionId: ctx.sessionManager.getSessionId(),
          runId: priorRun.runId,
          status: "interrupted",
          reasonCode: "PROCESS_RESTART_WITH_OPEN_RUN",
          attributes: { priorStatus: priorRun.status ?? "unknown", recoveryRequiresSideEffectCheck: true }
        });
      }
      if (activeTaskState?.status === "active" && activeTaskState.latestRunStatus === "running"
        && !finishedRunIds.has(activeTaskState.latestRunId ?? "")
        && !interruptedRuns.some((event) => event.runId === activeTaskState?.latestRunId)) {
        const interrupted = createTaskDomainEvent({
          kind: "run_interrupted", workspaceId: activeWorkspaceId, sessionId: activeSessionId,
          taskId: activeTaskState.taskId, branchId: activeTaskState.branchId,
          runId: activeTaskState.latestRunId,
          payload: { reason: "Process restarted while the task run was open." }
        });
        appendTaskEvent(ctx, interrupted);
        await appendRuntimeEvent(config.memoryDir, {
          kind: "run_interrupted", workspace: config.workspace, sessionId: activeSessionId,
          runId: activeTaskState.latestRunId, taskId: activeTaskState.taskId,
          branchId: activeTaskState.branchId, status: "interrupted",
          reasonCode: "PROCESS_RESTART_WITH_OPEN_RUN",
          attributes: { recoveryRequiresSideEffectCheck: true }
        });
      }
      await appendRuntimeEvent(config.memoryDir, {
        kind: "session_started",
        workspace: config.workspace,
        sessionId: ctx.sessionManager.getSessionId(),
        status: "idle"
      });
      ctx.ui.setStatus("actlume-runtime", memoryEnabled
        ? "Actlume context + scoped memory enabled"
        : "Actlume context enabled · memory treatment disabled");
      if (interruptedRuns.length > 0) {
        if (ctx.mode === "tui") {
          ctx.ui.setStatus("actlume-recovery", "interrupted run detected · inspect side effects before resuming");
          ctx.ui.notify("A prior Actlume run ended without a finish record. Check pending file or external side effects before asking the agent to retry.", "warning");
        }
      }
      if (config.baseURL) {
        ctx.ui.setStatus("actlume-pricing", "Custom endpoint · provider pricing unavailable");
      }
    });

    pi.on("session_tree", async (event, ctx) => {
      activeSessionId = ctx.sessionManager.getSessionId();
      const projection = projectionForContext(ctx);
      activeTaskProjection = projection;
      const taskState = projection.active;
      if (!taskState) {
        activeTaskState = projection.latest;
        activeTaskId = undefined;
        activeBranchId = undefined;
        activeBaseline = undefined;
        activeTask = "";
        return;
      }
      const nextBranchId = branchIdentity(activeWorkspaceId, activeSessionId, event.newLeafId);
      if (taskState.branchId !== nextBranchId) {
        const branched = appendTaskEvent(ctx, createTaskDomainEvent({
          kind: "task_branch", workspaceId: activeWorkspaceId, sessionId: activeSessionId,
          taskId: taskState.taskId, branchId: nextBranchId,
          payload: { parentSessionId: taskState.sessionId, parentBranchId: taskState.branchId, leafId: event.newLeafId ?? "" }
        }));
        if (branched) activeTaskState = branched;
      }
      activeTaskState = activeTaskState ?? taskState;
      activeTaskId = activeTaskState.taskId;
      activeBranchId = activeTaskState.branchId;
      activeBaseline = activeTaskState.baseline;
      activeTask = formatTaskContinuity(activeTaskState, "");
      activeWorkflow = activeTaskState.workflow
        ? PiRunWorkflow.fromSnapshot(activeTaskState.latestRunId ?? randomUUID(), activeTaskState.workflow)
        : new PiRunWorkflow(activeTaskState.latestRunId ?? randomUUID());
    });

    pi.on("session_before_compact", async (event, ctx) => {
      await appendRuntimeEvent(config.memoryDir, {
        kind: "context_budget_decision",
        workspace: config.workspace,
        sessionId: ctx.sessionManager.getSessionId(),
        runId: activeRunId,
        outcome: "warn",
        policyId: "pi-compaction-v1",
        reasonCode: "COMPACTION_REQUESTED",
        attributes: {
          reason: event.reason,
          willRetry: event.willRetry,
          branchEntryCount: event.branchEntries.length
        }
      });
    });

    pi.on("session_compact", async (event, ctx) => {
      await appendRuntimeEvent(config.memoryDir, {
        kind: "context_compacted",
        workspace: config.workspace,
        sessionId: ctx.sessionManager.getSessionId(),
        runId: activeRunId,
        status: "completed",
        attributes: {
          reason: event.reason,
          willRetry: event.willRetry,
          tokensBefore: event.compactionEntry.tokensBefore,
          summaryChars: event.compactionEntry.summary.length
        }
      });
    });

    pi.on("session_compact_failed", async (event, ctx) => {
      await appendRuntimeEvent(config.memoryDir, {
        kind: "context_compacted",
        workspace: config.workspace,
        sessionId: ctx.sessionManager.getSessionId(),
        runId: activeRunId,
        status: event.aborted ? "cancelled" : "failed",
        error: !event.aborted,
        reasonCode: event.aborted ? "COMPACTION_ABORTED" : "COMPACTION_FAILED",
        attributes: { reason: event.reason, willRetry: event.willRetry }
      });
    });

    if (memoryEnabled) pi.registerCommand("actlume-memory", {
      description: "List memories; promote, review, or disable <file>; revoke-user-consent disables cross-workspace user memory",
      handler: async (args, ctx) => {
        const [action, filename] = args.trim().split(/\s+/, 2);
        if (action === "revoke-user-consent") {
          if (ctx.mode !== "tui" || !await ctx.ui.confirm("Revoke user-memory consent", "Stop recalling user-wide memories in all Actlume workspaces for this OS user? Stored entries remain on disk until manually removed.")) {
            ctx.ui.notify("User-memory consent was not changed.", "warning");
            return;
          }
          await revokeUserMemoryConsent();
          ctx.ui.notify("Cross-workspace user-memory recall is disabled. Stored entries were retained.", "info");
          return;
        }
        if (["promote", "review", "disable"].includes(action ?? "") && filename) {
          const status = action === "promote" ? "active" : action === "review" ? "needs_review" : "disabled";
          const localEntries = await listMemories(config.memoryDir);
          const userEntries = await listMemories(getUserMemoryDir());
          const localTarget = localEntries.find((entry) => entry.filename === filename);
          const userTarget = userEntries.find((entry) => entry.filename === filename);
          const target = localTarget ?? userTarget;
          const targetStore = localTarget ? config.memoryDir : getUserMemoryDir();
          if (!target) {
            ctx.ui.notify(`Memory not found: ${filename}`, "warning");
            return;
          }
          if (action === "promote") {
            const prompt = target.scope === "user" && localTarget
              ? `Store '${target.name}' in the current OS user's memory store. If promoted, it may be recalled across all Actlume workspaces for this user. Continue?`
              : `Mark '${target.name}' as user-confirmed active context?`;
            if (ctx.mode !== "tui" || !await ctx.ui.confirm("Promote memory", prompt)) {
              ctx.ui.notify("Memory promotion was not confirmed.", "warning");
              return;
            }
            if (target.scope === "user" && localTarget) {
              const promoted = await promoteUserMemory(config.memoryDir, filename);
              if (!promoted || promoted.status !== "active") {
                ctx.ui.notify(promoted?.reviewReason ?? "User memory could not be activated; it remains available for review.", "warning");
                return;
              }
              ctx.ui.notify(`Memory ${promoted.filename} is active for the current OS user across Actlume workspaces.`, "info");
              return;
            }
          }
          if (target.scope === "user" && userTarget && action === "promote") {
            ctx.ui.notify("This user-wide memory is already active; no change was made.", "info");
            return;
          }
          await setMemoryStatus(targetStore, filename, status, action === "promote" ? "user_confirmed" : undefined);
          ctx.ui.notify(`Memory ${filename} is now ${status}.`, "info");
          return;
        }
        const entries = await listMemories(config.memoryDir);
        if (await hasUserMemoryConsent()) entries.push(...await listMemories(getUserMemoryDir()));
        const lines = entries.length === 0
          ? ["No typed memories are stored for this workspace or consented user store."]
          : entries.map((entry) => `- ${entry.name} (${entry.type}; ${entry.scope}; ${entry.status}; ${entry.evidenceType}) · ${entry.filename}`);
        ctx.ui.notify(lines.join("\n"), "info");
      }
    });

    pi.registerCommand("actlume-context", {
      description: "Show current Actlume context and retrieved memories",
      handler: async (_args, ctx) => {
        const usage = ctx.getContextUsage();
        const sessionId = ctx.sessionManager.getSessionId();
        const runEvents = (await readRuntimeEvents(config.memoryDir, sessionId)).filter((event) => event.runId === activeRunId);
        const providerUsage = runEvents.filter((event) => event.kind === "model_usage");
        const providerInput = sumKnownUsage(providerUsage.map((event) => event.usage?.input));
        const providerOutput = sumKnownUsage(providerUsage.map((event) => event.usage?.output));
        ctx.ui.notify([
          "Actlume injected context: " + (activeContextBudget
            ? `${activeContextBudget.usedTokens}/${activeContextBudget.maxTokens} estimated tokens · ${activeContextBudget.remainingTokens} remaining${activeContextBudget.truncated ? " · truncated" : ""} (characters ÷ 4 estimate)`
            : "not available"),
          `Workspace: ${config.workspace}`,
          `Selected memories: ${selectedMemoryFiles.length === 0 ? "none" : selectedMemoryFiles.join(", ")}`,
          `Pi session usage: ${usage?.tokens ?? "unknown"}${usage?.contextWindow ? ` / ${usage.contextWindow}` : ""} tokens`,
          `Provider-reported run usage: ${providerUsage.length} model requests · input ${providerInput ?? "unknown"} · output ${providerOutput ?? "unknown"} tokens`
        ].join("\n"), "info");
      }
    });

    pi.registerCommand("actlume-new-task", {
      description: "Start an independent Actlume task with a fresh workspace baseline",
      handler: async (args, ctx) => {
        const goal = args.trim();
        if (!goal) {
          ctx.ui.notify("Usage: /actlume-new-task <goal>", "warning");
          return;
        }
        const current = projectionForContext(ctx).active;
        if (current) {
          appendTaskEvent(ctx, createTaskDomainEvent({
            kind: "task_closed", workspaceId: activeWorkspaceId, sessionId: ctx.sessionManager.getSessionId(),
            taskId: current.taskId, branchId: current.branchId,
            payload: { reason: "Replaced by an explicit /actlume-new-task command." }
          }));
        }
        const sessionId = ctx.sessionManager.getSessionId();
        const leafId = leafIdForContext(ctx);
        const baseline = await captureWorkspaceSnapshot(config.workspace, [config.memoryDir]);
        const opened = appendTaskEvent(ctx, makeTaskOpenedEvent({
          workspaceId: activeWorkspaceId,
          sessionId,
          branchId: branchIdentity(activeWorkspaceId, sessionId, leafId),
          prompt: goal,
          baseline,
          entryId: leafId ?? undefined
        }));
        if (!opened) {
          ctx.ui.notify("Actlume could not persist the new task on this Pi session branch.", "error");
          return;
        }
        activeTaskState = opened;
        activeTaskProjection = { active: opened, latest: opened, issues: [] };
        activeTaskId = opened.taskId;
        activeBranchId = opened.branchId;
        activeSessionId = sessionId;
        activeBaseline = opened.baseline;
        activeAssessment = undefined;
        activeTask = formatTaskContinuity(opened, goal);
        activeWorkflow = new PiRunWorkflow(activeRunId);
        ctx.ui.notify(`Started task ${opened.taskId}. The next prompt will continue this goal.`, "info");
      }
    });

    pi.registerCommand("actlume-close-task", {
      description: "Close the active Actlume task on this Pi session branch",
      handler: async (_args, ctx) => {
        const current = projectionForContext(ctx).active;
        if (!current) {
          ctx.ui.notify("There is no active Actlume task on this Pi session branch.", "info");
          return;
        }
        const closed = appendTaskEvent(ctx, createTaskDomainEvent({
          kind: "task_closed", workspaceId: activeWorkspaceId, sessionId: ctx.sessionManager.getSessionId(),
          taskId: current.taskId, branchId: current.branchId, runId: current.latestRunId,
          payload: { reason: "Closed explicitly by the user." }
        }));
        activeTaskState = closed;
        activeTaskProjection = { latest: closed, issues: [] };
        activeTaskId = undefined;
        activeBranchId = undefined;
        activeTask = "";
        activeWorkflow = new PiRunWorkflow(randomUUID());
        ctx.ui.notify(`Closed Actlume task ${current.taskId}. The next prompt will open a new task.`, "info");
      }
    });

    for (const [command, verdict] of [["actlume-accept-task", "accepted"], ["actlume-reject-task", "rejected"]] as const) {
      pi.registerCommand(command, {
        description: verdict === "accepted" ? "Record a human acceptance verdict for the active task" : "Record a human rejection verdict for the active task",
        handler: async (args, ctx) => {
          const current = projectionForContext(ctx).active;
          if (!current) {
            ctx.ui.notify("There is no active Actlume task on this Pi session branch.", "warning");
            return;
          }
          if (ctx.mode !== "tui") {
            ctx.ui.notify("Human task verdicts must be recorded from the interactive TUI.", "warning");
            return;
          }
          const confirmed = await ctx.ui.confirm(
            verdict === "accepted" ? "Accept task result" : "Reject task result",
            `Record ${verdict} for task ${current.taskId} at requirement revision ${current.requirementRevision}?`,
            { signal: ctx.signal }
          );
          if (!confirmed || ctx.signal?.aborted) {
            ctx.ui.notify("Task verdict was not recorded.", "warning");
            return;
          }
          const reason = args.trim();
          const updated = appendTaskEvent(ctx, createTaskDomainEvent({
            kind: "task_verdict", workspaceId: activeWorkspaceId, sessionId: ctx.sessionManager.getSessionId(),
            taskId: current.taskId, branchId: current.branchId, runId: current.latestRunId,
            payload: { verdict, source: "human", reason }
          }));
          activeTaskState = updated;
          if (updated) activeTaskProjection = { active: updated, latest: updated, issues: [] };
          await appendRuntimeEvent(config.memoryDir, {
            kind: "task_verdict", workspace: config.workspace, sessionId: ctx.sessionManager.getSessionId(),
            runId: current.latestRunId, taskId: current.taskId, branchId: current.branchId,
            attributes: { verdict, source: "human", requirementRevision: current.requirementRevision, reason }
          });
          ctx.ui.notify(`Recorded human verdict: ${verdict}. Check evidence is shown separately.`, "info");
        }
      });
    }

    pi.registerCommand("actlume-changes", {
      description: "Show workspace differences from the most recent Actlume task baseline",
      handler: async (_args, ctx) => {
        const current = await captureWorkspaceSnapshot(config.workspace, [config.memoryDir]);
        const baseline = activeTaskState?.baseline ?? activeBaseline;
        const files = baseline ? changedFilesSince(baseline, current) : [];
        ctx.ui.notify([
          `Task: ${activeTaskState?.taskId ?? "none"} · ${activeTaskState?.status ?? "not opened"}`,
          `Run state: ${activeRunStatus}`,
          `Comparison: ${baseline?.capturedAt ?? "no task baseline"}`,
          files.length > 0 ? "Workspace differences:" : "No workspace differences since the recorded baseline.",
          ...files.map((path) => `- ${path}`)
        ].join("\n"), "info");
      }
    });

    pi.registerCommand("actlume-verify", {
      description: "Show verification records and whether they still match the current workspace",
      handler: async (_args, ctx) => {
        const records = await listVerificationRecords(config.memoryDir, activeSessionId);
        if (records.length === 0) {
          ctx.ui.notify("No verification records are available for this Pi session.", "info");
          return;
        }
        const current = await captureWorkspaceSnapshot(config.workspace, [config.memoryDir]);
        const lines = records.map((record) => {
          const state = isVerificationCurrent(record, current) ? "PASS · current" : record.ok ? "PASS · expired" : `FAIL · exit ${record.exitCode ?? "unknown"}`;
          return `- ${state} · ${record.kind} · ${record.command} · ${record.finishedAt}`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
      }
    });

    pi.registerCommand("actlume-result", {
      description: "Show the last run state and evidence-based outcome",
      handler: async (_args, ctx) => {
        const records = await listVerificationRecords(config.memoryDir, activeSessionId);
        ctx.ui.notify([
          `Runtime: ${activeRunStatus}`,
          `Evidence: ${activeAssessment?.evidenceStatus ?? "not assessed"}`,
          `Task verdict: ${activeTaskState?.taskVerdict ?? "unjudged"}${activeTaskState?.taskVerdictSource ? ` (${activeTaskState.taskVerdictSource})` : ""}`,
          activeTaskState?.taskVerdictReason ? `Verdict reason: ${activeTaskState.taskVerdictReason}` : "",
          `Model completion claim: ${activeTaskState?.completionClaim?.status ?? "unknown"}`,
          `Reason: ${activeAssessment?.reason ?? "No settled run is available."}`,
          `Changed files: ${activeAssessment?.changedFiles.join(", ") || "none recorded"}`,
          `Verification records: ${records.length}`
        ].join("\n"), activeAssessment?.evidenceStatus === "checks_failed" ? "error" : "info");
      }
    });

    pi.registerCommand("actlume-legacy", {
      description: "Read legacy Actlume JSON sessions; pass a session id to view its historical transcript",
      handler: async (args, ctx) => {
        const sessions = await listSessionSnapshots(config.memoryDir);
        const id = args.trim();
        if (!id) {
          ctx.ui.notify(formatLegacySessionList(sessions), "info");
          return;
        }
        const listed = sessions.find((session) => session.id === id);
        const snapshot = listed ? await loadSessionSnapshot(config.memoryDir, listed.id) : undefined;
        if (!snapshot) {
          ctx.ui.notify("Legacy session not found. Run /actlume-legacy to list available ids.", "warning");
          return;
        }
        const view = formatLegacySessionImport(snapshot, 8_000);
        ctx.ui.notify(view.content, "info");
      }
    });

    pi.registerCommand("actlume-import", {
      description: "Explicitly import a legacy Actlume session as quoted historical context into a new Pi session",
      handler: async (args, ctx) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Run /actlume-import <id> in the interactive TUI so the new session is visible and reviewable.", "warning");
          return;
        }
        const id = args.trim();
        const sessions = await listSessionSnapshots(config.memoryDir);
        const listed = sessions.find((session) => session.id === id);
        const snapshot = listed ? await loadSessionSnapshot(config.memoryDir, listed.id) : undefined;
        if (!snapshot) {
          ctx.ui.notify("Legacy session not found. Run /actlume-legacy to list available ids.", "warning");
          return;
        }
        const imported = formatLegacySessionImport(snapshot);
        const outcome = await ctx.newSession({
          setup: async (sessionManager) => {
            sessionManager.appendCustomMessageEntry("actlume.legacy-import", imported.content, true, {
              sourceSessionId: snapshot.metadata.id,
              sourceUpdatedAt: snapshot.updatedAt,
              importedHistoryItems: snapshot.history.length,
              truncated: imported.truncated,
              provenance: "historical-text-not-executable-tool-transcript"
            });
          },
          withSession: async (next) => {
            next.ui.notify("Imported legacy session " + snapshot.metadata.id + " as quoted context in a new Pi session." + (imported.truncated ? " The context was truncated; the original snapshot is unchanged." : ""), "info");
          }
        });
        if (outcome.cancelled) ctx.ui.notify("Legacy session import was cancelled; the source snapshot remains unchanged.", "warning");
      }
    });

    pi.registerCommand("actlume-doctor", {
      description: "Check Actlume runtime configuration",
      handler: async (_args, ctx) => {
        const report = await runDoctor({
          workspace: config.workspace,
          memoryDir: config.memoryDir,
          projectRoot: config.projectRoot,
          piCliPath: resolvePiCliPath(),
          model: config.model,
          baseURL: config.baseURL,
          apiKey: config.apiKey,
          mcpConfigPath: config.mcpConfigPath
        });
        ctx.ui.notify([
          formatDoctorReport(report),
          `Actlume tools: ${localTools.length}`,
          `OTLP trace export: ${isRuntimeTraceExportConfigured() ? formatTraceExportStatus(runtimeTraceExportDiagnostics()) : "disabled"}`,
          `Permission mode: ${config.permissionMode}${config.readonly ? " (read-only)" : ""}`
        ].join("\n\n"), report.exitCode === 0 ? "info" : "warning");
      }
    });
  };
}

function registerActlumeTool(
  pi: ExtensionAPI,
  tool: ToolDefinition,
  config: PiBridgeConfig,
  getRunContext: () => {
    runId: string;
    sessionId: string;
    taskId?: string;
    branchId?: string;
    requirementRevision?: number;
    baseline?: WorkspaceSnapshot;
    workflow: PiRunWorkflow;
    appendTaskEvent: (ctx: Pick<ExtensionContext, "sessionManager">, event: TaskDomainEvent) => PersistedTaskState | undefined;
  }
): void {
  const definition: PiToolDefinition = {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters as TSchema),
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      const startedAt = new Date().toISOString();
      const runContext = getRunContext();
      const releaseMutation = tool.sideEffect === "read" ? undefined : await acquireWorkspaceMutation(config.workspace);
      try {
      let checkSpec: CheckSpec | undefined;
      let checkBefore: WorkspaceSnapshot | undefined;
      let checkEnvironmentBefore: string | undefined;
      let checkFilesAvailableAtStart = false;
      let checkCwd: string | undefined;
      const shellArgs = typeof args === "object" && args !== null ? args as { command?: unknown; cwd?: unknown } : undefined;
      if (tool.name === "shell" && typeof shellArgs?.command === "string") {
        try {
          const specs = await loadCheckSpecs(config.workspace);
          checkCwd = resolveInsideCwd(config.workspace, typeof shellArgs.cwd === "string" ? shellArgs.cwd : ".");
          checkSpec = matchCheckSpec(config.workspace, specs, shellArgs.command, checkCwd);
          if (checkSpec) {
            checkBefore = await captureWorkspaceSnapshot(config.workspace, [config.memoryDir]);
            checkEnvironmentBefore = await checkEnvironmentId(config.workspace, checkSpec);
            checkFilesAvailableAtStart = await requiredCheckFilesAvailable(config.workspace, checkSpec);
          }
        } catch (error) {
          await appendRuntimeEvent(config.memoryDir, {
            kind: "policy_decision", workspace: config.workspace, sessionId: runContext.sessionId,
            runId: runContext.runId, taskId: runContext.taskId, branchId: runContext.branchId,
            toolCallId, toolName: tool.name, outcome: "warn", policyId: "check-spec-v1",
            reasonCode: "CHECK_CONFIG_OR_SCOPE_INVALID", attributes: { reason: (error as Error).message }
          });
        }
      }
      const result = config.memoryEnabled === false && ["memorySave", "memoryList", "memoryRecall"].includes(tool.name)
        ? {
            ok: false as const,
            content: "The memory treatment is disabled for this evaluation condition.",
            errorCode: "EVAL_MEMORY_DISABLED",
            retryable: false,
            metadata: { treatment: "disabled", sideEffectPerformed: false }
          }
        : await runRegisteredTool([tool], tool.name, args, {
            cwd: config.workspace,
            memoryDir: config.memoryDir,
            readonly: config.readonly,
            runId: runContext.runId,
            taskId: runContext.taskId,
            sessionId: runContext.sessionId,
            branchId: runContext.branchId,
            signal,
            permissionMode: config.permissionMode,
            securityPolicy: config.securityPolicy
          });
      if (!result.ok && typeof result.metadata === "object" && result.metadata !== null
        && (result.metadata as { outcome?: unknown }).outcome === "unknown") {
        await appendRuntimeEvent(config.memoryDir, {
          kind: "policy_decision", workspace: config.workspace, sessionId: runContext.sessionId,
          runId: runContext.runId, taskId: runContext.taskId, branchId: runContext.branchId,
          toolCallId, toolName: tool.name, outcome: "unknown", policyId: "mcp-result-v1",
          reasonCode: result.errorCode,
          attributes: { remoteResult: "unknown", retryable: false }
        });
      }
      runContext.workflow.record(tool.name, args, {
        isError: !result.ok,
        content: result.content,
        details: result.ok ? { metadata: result.metadata } : { errorCode: result.errorCode, metadata: result.metadata }
      }, toolCallId);
      const persisted = tool.name === "readArtifact"
        ? { observation: result.content, artifactPath: undefined, originalChars: result.content.length }
        : await persistLargeObservation({
        memoryDir: config.memoryDir,
        runId: runContext.runId,
        step: runContext.workflow.history.length,
        toolName: tool.name,
        observation: result.content
      });
      if (tool.name === "shell" && runContext.baseline && checkSpec && checkBefore && shellArgs) {
        const metadata = result.metadata as { result?: { exitCode?: unknown; outcome?: unknown } } | undefined;
        const shellResult = metadata?.result;
        const exitCode = typeof shellResult?.exitCode === "number" ? shellResult.exitCode : null;
        const outcome = shellResult?.outcome;
        const exitReason = outcome === "cancelled" ? "cancelled"
          : outcome === "timed_out" ? "timeout"
            : outcome === "start_failed" ? "start_failed"
              : outcome === "unknown" ? "unknown" : "exit";
        if (typeof shellArgs.command === "string" && checkCwd) {
          const verification = await createVerificationRecord({
            memoryDir: config.memoryDir,
            workspace: config.workspace,
            baseline: runContext.baseline,
            sessionId: runContext.sessionId,
            runId: runContext.runId,
            taskId: runContext.taskId,
            requirementRevision: runContext.requirementRevision,
            toolCallId,
            command: shellArgs.command,
            cwd: checkCwd,
            checkSpec,
            beforeSnapshot: checkBefore,
            requiredFilesAvailableAtStart: checkFilesAvailableAtStart,
            environmentIdAtStart: checkEnvironmentBefore,
            outputArtifactPath: persisted.artifactPath,
            startedAt,
            exitCode,
            exitReason
          });
          if (verification) {
            if (runContext.taskId && runContext.branchId) {
              runContext.appendTaskEvent(ctx, createTaskDomainEvent({
                kind: "verification", workspaceId: workspaceIdentity(config.workspace), sessionId: runContext.sessionId,
                taskId: runContext.taskId, branchId: runContext.branchId, runId: runContext.runId,
                toolCallId, toolName: tool.name,
                payload: { verificationId: verification.id, evidenceStatus: verification.evidenceStatus, specId: verification.specId, kind: verification.kind }
              }));
            }
            await appendRuntimeEvent(config.memoryDir, {
              kind: "verification_finished",
              workspace: config.workspace,
              sessionId: runContext.sessionId,
              runId: runContext.runId,
              toolCallId,
              status: verification.evidenceStatus === "checks_passed" ? "completed"
                : verification.evidenceStatus === "checks_failed" || verification.exitReason === "timeout" || verification.exitReason === "start_failed" ? "failed"
                  : verification.exitReason === "cancelled" ? "cancelled" : "interrupted",
              error: verification.evidenceStatus === "checks_failed" || verification.exitReason === "timeout" || verification.exitReason === "start_failed",
              taskId: runContext.taskId,
              branchId: runContext.branchId,
              attributes: {
                verificationId: verification.id,
                evidenceStatus: verification.evidenceStatus ?? "unknown",
                checkSpecId: verification.specId ?? "unknown",
                checkKind: verification.kind,
                beforeFingerprint: verification.beforeFingerprint ?? "unavailable",
                fingerprint: verification.workspaceFingerprint ?? "unavailable",
                environmentId: verification.environmentId ?? "unavailable",
                outputArtifactPath: verification.outputArtifactPath ?? "unavailable"
              }
            });
          }
        }
      }
      return {
        content: [{ type: "text", text: persisted.observation }],
        details: {
          toolCallId,
          errorCode: result.ok ? undefined : result.errorCode,
          retryable: result.ok ? undefined : result.retryable,
          metadata: { result: result.metadata, artifactPath: persisted.artifactPath, originalChars: persisted.originalChars }
        },
        isError: !result.ok
      };
      } finally {
        releaseMutation?.();
      }
    }
  };
  pi.registerTool(definition);
}

type ScopedResearchRequest = {
  tasks: Array<{ id: string; goal: string; scope?: string[]; context?: string }>;
  maxSteps?: number;
  timeoutMs?: number;
};

function registerScopedResearchTool(
  pi: ExtensionAPI,
  config: PiBridgeConfig,
  getParent: () => { runId: string; sessionId: string; selectedMemoryFiles: string[]; workflow: PiRunWorkflow }
): void {
  pi.registerTool({
    name: "scopedResearch",
    label: "scopedResearch",
    description: "Run 1–3 independent, read-only research subtasks in isolated Pi sessions. Returns structured findings with file evidence. Do not delegate dependent work.",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1 },
              goal: { type: "string", minLength: 1 },
              scope: { type: "array", items: { type: "string" }, default: [] },
              context: { type: "string" }
            },
            required: ["id", "goal"]
          }
        },
        maxSteps: { type: "integer", minimum: 1, maximum: 8, default: 5 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000, default: 60000 }
      },
      required: ["tasks"]
    } as TSchema),
    executionMode: "sequential",
    async execute(toolCallId, rawArgs, signal) {
      const args = rawArgs as ScopedResearchRequest;
      const parent = getParent();
      const memories = await listMemories(config.memoryDir);
      const sharedMemoryContext = buildRelevantMemoryContext(
        memories.filter((memory) => parent.selectedMemoryFiles.includes(memory.filename))
      );
      const maxSteps = Math.min(8, Math.max(1, args.maxSteps ?? 5));
      const timeoutMs = Math.min(120000, Math.max(1000, args.timeoutMs ?? 60000));
      const results = await Promise.all(args.tasks.map(async (task) => {
        const agentId = "agent-" + randomUUID();
        const startedAt = Date.now();
        await appendRuntimeEvent(config.memoryDir, {
          kind: "agent_started", workspace: config.workspace, sessionId: parent.sessionId,
          runId: parent.runId, agentId, parentRunId: parent.runId, toolCallId, status: "running",
          attributes: { taskId: task.id, maxSteps, timeoutMs, mode: "read-only" }
        });
        const result = await runScopedResearchChild({ config, parentRunId: parent.runId, agentId, task, sharedMemoryContext, maxSteps, timeoutMs, signal });
        const attributes: NonNullable<RuntimeEvent["attributes"]> = {
          taskId: task.id,
          childSessionId: agentId,
          toolCalls: result.toolCalls,
          modelRequests: result.modelRequests,
          unresolvedCount: result.structured.unresolved.length
        };
        if (result.inputTokens !== undefined) attributes.inputTokens = result.inputTokens;
        if (result.outputTokens !== undefined) attributes.outputTokens = result.outputTokens;
        await appendRuntimeEvent(config.memoryDir, {
          kind: "agent_finished", workspace: config.workspace, sessionId: parent.sessionId,
          runId: result.runId ?? parent.runId, agentId, parentRunId: parent.runId, toolCallId,
          status: result.status, durationMs: Date.now() - startedAt, error: result.status !== "completed",
          attributes
        });
        return { taskId: task.id, agentId, ...result };
      }));
      parent.workflow.record("scopedResearch", args, {
        isError: results.every((result) => result.status !== "completed"),
        content: JSON.stringify(results),
        details: { errorCode: results.every((result) => result.status !== "completed") ? "SUBAGENTS_FAILED" : undefined }
      }, toolCallId);
      return {
        content: [{ type: "text", text: JSON.stringify({ parentRunId: parent.runId, results }, null, 2) }],
        details: { parentRunId: parent.runId, toolCallId, agents: results.map((result) => result.agentId) },
        isError: results.every((result) => result.status !== "completed")
      };
    }
  });
}

async function runScopedResearchChild(input: {
  config: PiBridgeConfig;
  parentRunId: string;
  agentId: string;
  task: ScopedResearchRequest["tasks"][number];
  sharedMemoryContext: string;
  maxSteps: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{
  runId?: string;
  status: RuntimeStatus;
  answer: string;
  structured: { summary: string; findings: Array<{ claim: string; evidence: string[] }>; unresolved: string[] };
  toolCalls: number;
  modelRequests: number;
  inputTokens?: number;
  outputTokens?: number;
}> {
  const { config, parentRunId, agentId, task } = input;
  const childMemoryDir = join(config.memoryDir, "subagents", parentRunId, agentId);
  await mkdir(childMemoryDir, { recursive: true });
  const childConfig: PiBridgeConfig = {
    ...config,
    memoryDir: childMemoryDir,
    readonly: true,
    permissionMode: "plan",
    maxSteps: input.maxSteps,
    maxToolCalls: Math.max(8, input.maxSteps * 3),
    allowedTools: ["projectScan", "glob", "listDir", "tree", "searchText", "readFile", "readTail", "fileExists", "recall"],
    disableMcp: true,
    agentId: input.agentId,
    parentRunId: input.parentRunId,
    subAgentDepth: (config.subAgentDepth ?? 0) + 1
  };
  const client = new RpcClient({
    cliPath: resolvePiCliPath(),
    cwd: config.workspace,
    env: {
      ...process.env,
      ...(config.apiKey ? { OPENAI_API_KEY: config.apiKey } : {}),
      [bridgeConfigEnv]: JSON.stringify(childConfig)
    },
    args: buildPiLaunchArgs(childConfig, undefined, { sessionId: input.agentId })
  });
  const prompt = [
    "You are a scoped read-only research sub-agent. Do not edit files, execute shell commands, launch other agents, or modify memory.",
    "Return one JSON object with these fields: summary (string), findings (array of {claim:string,evidence:string[]}), unresolved (string[]).",
    "Evidence must name workspace-relative file paths and relevant line numbers when available. Distinguish observed facts from inference.",
    "Subtask ID: " + task.id,
    "Goal: " + task.goal,
    "Allowed inspection scope: " + ((task.scope?.length ?? 0) > 0 ? task.scope?.join(", ") : "the current workspace, only as needed"),
    task.context ? "Task-specific context:\n" + task.context : "",
    input.sharedMemoryContext ? "Read-only project memory selected by the parent:\n" + input.sharedMemoryContext : ""
  ].filter(Boolean).join("\n\n");
  const abortChild = () => { void client.abort().catch(() => undefined); };
  input.signal?.addEventListener("abort", abortChild, { once: true });
  let answer = "";
  try {
    if (input.signal?.aborted) throw new Error("Parent task cancelled this subtask.");
    await client.start();
    await client.promptAndWait(prompt, undefined, input.timeoutMs);
    answer = await client.getLastAssistantText() ?? "";
    const events = await readRuntimeEvents(childMemoryDir, input.agentId);
    const finished = [...events].reverse().find((event) => event.kind === "run_finished");
    const usageEvents = events.filter((event) => event.kind === "model_usage");
    if (input.signal?.aborted) {
      const message = "Parent task cancelled this subtask.";
      return {
        runId: finished?.runId,
        status: "cancelled",
        answer: message,
        structured: { summary: "", findings: [], unresolved: [message] },
        toolCalls: events.filter((event) => event.kind === "tool_finished").length,
        modelRequests: usageEvents.length,
        inputTokens: sumKnownUsage(usageEvents.map((event) => event.usage?.input)),
        outputTokens: sumKnownUsage(usageEvents.map((event) => event.usage?.output))
      };
    }
    return {
      runId: finished?.runId,
      status: finished?.status ?? "completed",
      answer,
      structured: normalizeScopedAnswer(extractScopedJson(answer), answer),
      toolCalls: events.filter((event) => event.kind === "tool_finished").length,
      modelRequests: usageEvents.length,
      inputTokens: sumKnownUsage(usageEvents.map((event) => event.usage?.input)),
      outputTokens: sumKnownUsage(usageEvents.map((event) => event.usage?.output))
    };
  } catch (error) {
    if (!input.signal?.aborted) await client.abort().catch(() => undefined);
    const message = input.signal?.aborted ? "Parent task cancelled this subtask." : (error as Error).message;
    return {
      status: input.signal?.aborted ? "cancelled" : "failed",
      answer: message,
      structured: { summary: "", findings: [], unresolved: [message || "Subtask failed before returning a result."] },
      toolCalls: 0,
      modelRequests: 0
    };
  } finally {
    input.signal?.removeEventListener("abort", abortChild);
    await client.stop();
  }
}

function extractScopedJson(answer: string): unknown {
  try {
    return JSON.parse(answer.trim()) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeScopedAnswer(value: unknown, fallback: string): { summary: string; findings: Array<{ claim: string; evidence: string[] }>; unresolved: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { summary: fallback, findings: [], unresolved: ["The child response was not valid structured JSON."] };
  }
  const record = value as Record<string, unknown>;
  const findings = Array.isArray(record.findings) ? record.findings.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const finding = item as Record<string, unknown>;
    if (typeof finding.claim !== "string") return [];
    return [{
      claim: finding.claim,
      evidence: Array.isArray(finding.evidence)
        ? finding.evidence.filter((entry): entry is string => typeof entry === "string")
        : []
    }];
  }) : [];
  return {
    summary: typeof record.summary === "string" ? record.summary : fallback,
    findings,
    unresolved: Array.isArray(record.unresolved)
      ? record.unresolved.filter((entry): entry is string => typeof entry === "string")
      : []
  };
}

function sumKnownUsage(values: Array<number | undefined>): number | undefined {
  if (values.length === 0 || values.some((value) => value === undefined)) return undefined;
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

async function enforceActlumePolicy(
  event: ToolCallEvent,
  ui: ExtensionUIContext,
  mode: "tui" | "rpc" | "json" | "print",
  config: PiBridgeConfig,
  localToolsByName: Map<string, ToolDefinition>,
  signal: AbortSignal | undefined,
  identity: { sessionId: string; runId: string; taskId?: string; branchId?: string }
): Promise<{ block: true; reason: string } | void> {
  if (signal?.aborted) return { block: true, reason: "The tool call was cancelled before approval or execution." };
  const actlumeName = mapPiToolToActlumeName(event.toolName);
  const sideEffect = localToolsByName.get(actlumeName)?.sideEffect ?? getToolSideEffect(event.toolName);
  if ((config.readonly || config.permissionMode === "plan") && sideEffect !== "read" && !(config.permissionMode === "plan" && isPlanModeAllowedWriteTool(actlumeName))) {
    return { block: true, reason: "Actlume is in read-only or plan mode; this operation can change state." };
  }

  const check = checkToolPermission(
    {
      name: actlumeName,
      description: "Pi tool policy adapter",
      sideEffect,
      parameters: {},
      run: async () => ({ ok: true, content: "" })
    },
    config.securityPolicy
  );
  if (!check.allowed) return { block: true, reason: check.reason };

  const input = event.input as unknown as Record<string, unknown>;
  const command = typeof input.command === "string"
    ? input.command
    : typeof input.script === "string"
      ? input.script
      : undefined;
  let needsReview = sideEffect !== "read" && !shouldAutoApproveTool(sideEffect, config.permissionMode);
  if (command) {
    const assessment = assessShellCommand(command, config.securityPolicy);
    if (!assessment.allowed) return { block: true, reason: assessment.reason ?? "Shell command blocked by Actlume policy." };
    needsReview ||= assessment.risk === "medium" || assessment.risk === "high";
  }

  const targetPath = [input.path, input.filePath, input.file_path].find((value) => typeof value === "string");
  if (sideEffect === "write" && typeof targetPath === "string" && isSensitivePath(targetPath)) {
    needsReview = true;
  }
  if (!needsReview) return;
  if (mode !== "tui") {
    if (config.allowHeadlessCheckSpec && sideEffect === "execute" && command) {
      const requestedCwd = typeof input.cwd === "string" ? input.cwd : ".";
      try {
        const checkCwd = resolveInsideCwd(config.workspace, requestedCwd);
        const specs = await loadCheckSpecs(config.workspace);
        const checkSpec = matchCheckSpec(config.workspace, specs, command, checkCwd);
        if (checkSpec) {
          await appendRuntimeEvent(config.memoryDir, {
            kind: "policy_decision",
            workspace: config.workspace,
            sessionId: identity.sessionId,
            runId: identity.runId,
            taskId: identity.taskId,
            branchId: identity.branchId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            outcome: "allow",
            policyId: "headless-checkspec-v1",
            reasonCode: "EXACT_CONFIGURED_CHECKSPEC_AUTOAPPROVED",
            attributes: {
              checkSpecId: checkSpec.id,
              commandHash: hashAttribution(command),
              configuredCwd: checkSpec.cwd,
              permissionMode: config.permissionMode
            }
          });
          return;
        }
      } catch (error) {
        await appendRuntimeEvent(config.memoryDir, {
          kind: "policy_decision",
          workspace: config.workspace,
          sessionId: identity.sessionId,
          runId: identity.runId,
          taskId: identity.taskId,
          branchId: identity.branchId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          outcome: "warn",
          policyId: "headless-checkspec-v1",
          reasonCode: "CHECKSPEC_AUTOAPPROVAL_LOOKUP_FAILED",
          attributes: { detail: (error as Error).message }
        });
      }
    }
    return { block: true, reason: `Interactive approval is required for ${event.toolName}; run this task in the Actlume TUI or select an explicit permission mode.` };
  }
  if (shouldAutoDenyConfirmation(config.permissionMode)) {
    return { block: true, reason: `Permission mode ${config.permissionMode} denied a confirmation-required operation.` };
  }

  const inputPreview = JSON.stringify(event.input, null, 2);
  const approved = await ui.confirm(
    "Actlume permission required",
    `${event.toolName} (${sideEffect})\n${inputPreview.length > 3_000 ? `${inputPreview.slice(0, 3_000)}\n[truncated]` : inputPreview}`,
    { signal }
  );
  if (signal?.aborted) return { block: true, reason: "Approval was cancelled; the tool did not execute." };
  if (!approved) return { block: true, reason: `User rejected ${event.toolName}.` };
}

function getToolSideEffect(toolName: string): ToolSideEffect {
  if (["read", "grep", "find", "ls", "projectScan", "glob", "listDir", "tree", "searchText", "readFile", "readTail", "fileExists", "memoryList", "memoryRecall", "recall", "taskList", "readPlan", "readArtifact", "scopedResearch"].includes(toolName)) return "read";
  if (["edit", "write", "writePlan", "updatePlan", "exitPlanMode", "editPlan", "memorySave", "taskAdd", "taskUpdate", "writeFile", "appendFile", "appendToFile", "replaceText", "insertText", "replaceLines", "insertAtLine", "applyPatch"].includes(toolName)) return "write";
  return "execute";
}

function mapPiToolToActlumeName(toolName: string): string {
  const names: Record<string, string> = {
    read: "readFile",
    grep: "searchText",
    find: "glob",
    ls: "listDir",
    edit: "applyPatch",
    write: "writeFile",
    bash: "shell",
    powershell: "shell"
  };
  return names[toolName] ?? toolName;
}

function hashAttribution(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function formatTraceExportStatus(diagnostics: ReturnType<typeof runtimeTraceExportDiagnostics>): string {
  if (!diagnostics) return "configured; no exporter diagnostics yet";
  return `configured · ${diagnostics.queued} queued · ${diagnostics.dropped} dropped · ${diagnostics.httpErrors} HTTP errors · ${diagnostics.timeouts} timeouts`;
}

function isTaskSpecificPolicyError(errorCode: string | undefined): boolean {
  return errorCode === "EDIT_PLAN_REQUIRED_FIRST" || errorCode === "TARGET_NOT_LOCATED_PRECHECK_FAILED";
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const record = part as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("\n");
}
