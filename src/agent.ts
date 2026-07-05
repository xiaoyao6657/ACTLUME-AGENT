import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ActionStore } from "./action-store.js";
import { persistLargeObservation } from "./context-artifacts.js";
import { compactHistoryForPrompt } from "./context-policy.js";
import { getContextBudget } from "./context-budget.js";
import {
  EditWorkflowStore,
  extractShellCommand,
  formatEditWorkflowSummary,
  isShellCheckCommand,
  pickCheckCommand,
  requiresEditPlan,
  type EditWorkflowState
} from "./edit-workflow.js";
import { hasMcpSearchTool, missingSearchToolMessage, requiresRealtimeExternalInfo } from "./external-info.js";
import { callLLM } from "./llm.js";
import { buildMemoryPromptSection } from "./memory.js";
import { inferModelProfile, modelProfileForPrompt } from "./model-adapter.js";
import { formatActionInputForPrompt, parseAgentOutput } from "./output-parser.js";
import { buildWorkspacePromptContext } from "./prompt.js";
import { formatProjectScan, scanProjectWithCache } from "./project-scan.js";
import { RunLogger } from "./run-log.js";
import { assessShellCommand, defaultSecurityPolicy, isSensitivePath, sensitivePathMessage, shouldAutoApproveTool, shouldAutoDenyConfirmation } from "./security.js";
import {
  isShellFileEditCommand,
  isShellFileReadCommand,
  isShellEnvironmentSetupCommand,
  isShellVerificationCommand,
} from "./shell-classify.js";
import { summarizeObservation, summarizeText } from "./summary.js";
import { formatToolResultForObservation, toolFailure } from "./tool-result.js";
import { buildToolConfirmationRequest } from "./tool-preview.js";
import { runRegisteredTool } from "./tool-scheduler.js";
import type {
  AgentActionOutput,
  AgentHistoryItem,
  ToolConfirmationRequest,
  ToolContext,
  ToolDefinition,
  ToolResult,
  SecurityPolicy,
  PermissionMode
} from "./types.js";
import { getToolDescriptions, tools as localTools } from "./tools/registry.js";
import {
  isCodingChangeTask,
  maybeBlockByStageBudget,
  navigateWorkflow,
  classifyActionIntent,
  workflowPolicyForNavigation,
  formatAllowedIntentsForPrompt,
  workflowProfileForTask,
  issueFixPromptHints,
  isReadyForFinal,
  answerLooksIncomplete,
  type DuplicatePythonTestFunction,
  countRecentWorkflowGuardBlocks,
} from "./workflow-guard.js";

// Re-export for test backward compatibility
export {
  isCodingChangeTask,
  maybeBlockByStageBudget,
  navigateWorkflow,
  classifyActionIntent,
  workflowPolicyForNavigation,
  formatAllowedIntentsForPrompt,
  workflowProfileForTask,
  issueFixPromptHints,
  isReadyForFinal,
  answerLooksIncomplete,
  isShellFileEditCommand,
  isShellFileReadCommand,
  isShellEnvironmentSetupCommand,
  isShellVerificationCommand,
  parseAgentOutput,
  formatActionInputForPrompt,
};
export type { EditWorkflowState };

export type RunAgentOptions = {
  userTask: string;
  cwd?: string;
  memoryDir?: string;
  maxSteps?: number;
  readonly?: boolean;
  runId?: string;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  tools?: ToolDefinition[];
  autoConfirm?: boolean;
  permissionMode?: PermissionMode;
  streaming?: boolean;
  securityPolicy?: SecurityPolicy;
  confirmToolCall?: (request: ToolConfirmationRequest) => Promise<boolean>;
  initialHistory?: AgentHistoryItem[];
  initialWorkflowState?: EditWorkflowState;
};

export type RunAgentResult = {
  answer: string;
  status: "completed" | "failed" | "max_steps";
  runId: string;
  logPath: string;
  stepsUsed: number;
  toolCalls: number;
  history: AgentHistoryItem[];
  workflowState: EditWorkflowState;
};

type ProjectContextInfo = {
  text: string;
  suggestedChecks: string[];
};

const actionSchema = z.object({
  type: z.literal("action"),
  thought: z.string(),
  tool: z.string(),
  input: z.unknown()
});

const finalSchema = z.object({
  type: z.literal("final"),
  answer: z.string()
});

const agentOutputSchema = z.union([actionSchema, finalSchema]);

const DEFAULT_MAX_STEPS_CODING = 30;
const DEFAULT_MAX_STEPS_OTHER = 8;

function defaultMaxStepsFor(userTask: string): number {
  if (isCodingChangeTask(userTask)) {
    return DEFAULT_MAX_STEPS_CODING;
  }
  return DEFAULT_MAX_STEPS_OTHER;
}

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const cwd = options.cwd ?? process.cwd();
  const memoryDir = options.memoryDir ?? process.env.AGENT_MEMORY_DIR ?? ".agent-memory";
  const maxSteps = options.maxSteps ?? Number(process.env.AGENT_MAX_STEPS ?? defaultMaxStepsFor(options.userTask));
  const runId = options.runId ?? crypto.randomUUID();
  const permissionMode = options.permissionMode ?? (options.autoConfirm ? "bypassPermissions" : "default");
  const ctx: ToolContext = {
    cwd,
    memoryDir,
    readonly: (options.readonly ?? false) || permissionMode === "plan",
    runId,
    permissionMode,
    securityPolicy: options.securityPolicy ?? defaultSecurityPolicy
  };
  const availableTools = options.tools ?? localTools;
  const modelProfile = inferModelProfile({ model: options.model, baseURL: options.baseURL });
  const actionStore = new ActionStore(memoryDir);
  const logger = new RunLogger(memoryDir, runId);
  const editWorkflow = new EditWorkflowStore(memoryDir, runId);
  await editWorkflow.reset();
  const projectContext = await buildProjectContext(cwd, memoryDir);
  const history: AgentHistoryItem[] = [];
  let invalidJsonRetries = 0;
  let autoRepairAttempts = 0;
  let finalAssessmentRetries = 0;
  let stepsUsed = 0;
  let toolCalls = 0;
  const finishResult = async (answer: string, status: RunAgentResult["status"]): Promise<RunAgentResult> => ({
    answer, status, runId: logger.runId, logPath: logger.filePath, stepsUsed, toolCalls, history,
    workflowState: await editWorkflow.get()
  });

  await logger.write({
    event: "run_start",
    data: {
      userTask: options.userTask,
      cwd,
      memoryDir,
      maxSteps,
      readonly: ctx.readonly,
      model: options.model,
      modelProfile,
      projectContext: projectContext.text
    }
  });

  if (requiresRealtimeExternalInfo(options.userTask) && !hasMcpSearchTool(availableTools)) {
    const answer = missingSearchToolMessage(options.userTask);
    await logger.write({ event: "external_info_blocked", data: { answer, availableTools: availableTools.map((tool) => tool.name) } });
    await logger.write({ event: "run_end", data: { status: "failed", answer } });
    return await finishResult(answer, "failed");
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    stepsUsed = step;
    const isFinalTurn = step === maxSteps;
    const workflowAtTurnStart = await editWorkflow.get();
    const prompt = buildPrompt(options.userTask, history, availableTools, projectContext.text, modelProfileForPrompt(modelProfile), {
      finalTurn: isFinalTurn,
      step,
      maxSteps,
      workflowState: workflowAtTurnStart
    });
    await logger.write({ event: "turn_start", step, data: { prompt } });
    console.log(`\n[turn ${step}] LLM`);
    const raw = await callLLM(prompt, { model: options.model, apiKey: options.apiKey, baseURL: options.baseURL });
    await logger.write({ event: "llm_response", step, data: { raw } });
    const parsed = parseAgentOutput(raw);

    if (!parsed.ok) {
      invalidJsonRetries += 1;
      const observation = `Invalid agent JSON output: ${parsed.error}. Raw output: ${raw.slice(0, 1000)}`;
      console.log(`[observation]\n${observation}`);
      await logger.write({ event: "parse_error", step, data: { error: parsed.error, observation } });

      if (invalidJsonRetries > 2) {
        const answer = `Stopped after repeated invalid JSON output. Last error: ${parsed.error}`;
        await logger.write({ event: "run_end", data: { status: "failed", answer } });
        return await finishResult(answer, "failed");
      }

      history.push({
        thought: "The model returned invalid JSON and must retry with the protocol.",
        action: {
          type: "action",
          thought: "Protocol repair",
          tool: "none",
          input: {}
        },
        observation
      });
      continue;
    }

    invalidJsonRetries = 0;
    if (parsed.value.type === "final") {
      const workflowBeforeFinal = await editWorkflow.get();
      const requiresEdits = shouldRequireEditsBeforeFinal(options.userTask, workflowBeforeFinal);
      if (requiresEdits && isFinalTurn) {
        const answer =
          `${parsed.value.answer}\n\n` +
          "Task ended without recorded code edits, so this run is not considered completed. " +
          "For a fix/implementation task, rerun with a narrower instruction or make sure the agent calls editPlan and applies a focused edit.";
        await logger.write({ event: "final_without_required_edits", step, data: { answer } });
        await logger.write({ event: "run_end", data: { status: "failed", answer } });
        return await finishResult(answer, "failed");
      }

      if (requiresEdits) {
        const observation =
          "This task asks for a code change, but no file changes have been recorded yet. Do not finish with only analysis. Call editPlan if needed, make the focused change with replaceLines, insertAtLine, appendToFile, replaceText, insertText, applyPatch, or writeFile, then run a relevant check.";
        await logger.write({ event: "premature_final_blocked", step, data: { answer: parsed.value.answer, observation } });
        history.push({
          thought: "The model attempted to finish a coding task before making edits.",
          action: {
            type: "action",
            thought: "Premature final blocked",
            tool: "none",
            input: {}
          },
          observation
        });
        continue;
      }

      const completion = await completeEditWorkflow({
        availableTools,
        actionStore,
        editWorkflow,
        projectContext,
        ctx,
        options,
        logger,
        step,
        canRepair: autoRepairAttempts < 1 && step < maxSteps
      });
      toolCalls += completion.toolCalls;

      if (completion.repairObservation) {
        autoRepairAttempts += 1;
        history.push({
          thought: "Automatic project check failed; the agent should inspect the failure and repair once.",
          action: completion.action,
          observation: completion.repairObservation
        });
        continue;
      }

      const workspaceChangedFiles = await getGitChangedFiles(ctx.cwd);
      const finalAssessment = assessFinalCompletion(options.userTask, parsed.value.answer, completion.workflowState, {
        workspaceChangedFiles,
        duplicateTestFunctions: await getDuplicatePythonTestFunctions(ctx.cwd, [
          ...workspaceChangedFiles,
          ...completion.workflowState.changedFiles.map((item) => item.path)
        ])
      });
      if (!finalAssessment.ok && !isFinalTurn && finalAssessmentRetries < 2) {
        finalAssessmentRetries += 1;
        const observation =
          `${finalAssessment.message}\n` +
          "Do not finish yet. Make the smallest repair needed for these reasons, run the relevant check again if files change, then provide final.";
        await logger.write({
          event: "final_assessment_blocked",
          step,
          data: { answer: parsed.value.answer, assessment: finalAssessment, observation }
        });
        history.push({
          thought: "The model attempted to finish before the final quality checks passed.",
          action: {
            type: "action",
            thought: "Final quality assessment blocked",
            tool: "none",
            input: {}
          },
          observation
        });
        continue;
      }

      const answer = appendWorkflowSummary(
        finalAssessment.ok ? parsed.value.answer : `${parsed.value.answer}\n\n${finalAssessment.message}`,
        completion.workflowState,
        completion.gitDiffSummary
      );
      console.log("Final:");
      console.log(answer);
      if (!finalAssessment.ok) {
        await logger.write({ event: "final_incomplete", step, data: { answer, assessment: finalAssessment } });
        await logger.write({ event: "run_end", data: { status: "failed", answer } });
        return await finishResult(answer, "failed");
      }

      await logger.write({ event: "final", step, data: { answer } });
      await logger.write({ event: "run_end", data: { status: "completed", answer } });
      return await finishResult(answer, "completed");
    }

    if (isFinalTurn) {
      const attempted = parsed.value;
      const answer =
        attempted.type === "action"
          ? `Reached final turn before completion. The model attempted another tool call (${attempted.tool}) instead of summarizing. Last thought: ${attempted.thought}`
          : "Reached final turn before completion.";
      await logger.write({ event: "final_turn_action_blocked", step, data: { attempted, answer } });
      await logger.write({ event: "run_end", data: { status: "max_steps", answer } });
      return await finishResult(answer, "max_steps");
    }

    const action = parsed.value;
    toolCalls += 1;
    console.log(`Thought: ${action.thought}`);
    console.log(`Action: ${action.tool} ${JSON.stringify(action.input)}`);

    const stageBlocked = maybeBlockByStageBudget(action, options.userTask, step, maxSteps, await editWorkflow.get(), history);
    const toolResult = stageBlocked ?? (await maybeConfirmAndRunTool(availableTools, action, ctx, options, editWorkflow));
    const observation = formatToolResultForObservation(toolResult);
    const compactObservation = summarizeObservation(observation);
    console.log("[observation]");
    console.log(compactObservation);
    await logger.write({ event: "tool_result", step, data: { action, toolResult, observation } });

    await actionStore.save({
      thought: action.thought,
      toolName: action.tool,
      toolInput: action.input,
      toolResult,
      observation,
      summary: compactObservation
    });

    await recordEditWorkflowEffect(editWorkflow, action, toolResult, projectContext.suggestedChecks);

    history.push({
      thought: action.thought,
      action,
      observation
    });
  }

  const answer = `Reached max steps (${maxSteps}); task may be incomplete.`;
  await logger.write({ event: "run_end", data: { status: "max_steps", answer } });
  return await finishResult(answer, "max_steps");
}

async function maybeConfirmAndRunTool(
  availableTools: ToolDefinition[],
  action: AgentActionOutput,
  ctx: ToolContext,
  options: RunAgentOptions,
  editWorkflow: EditWorkflowStore
): Promise<ToolResult> {
  const tool = availableTools.find((item) => item.name === action.tool);
  if (tool && requiresEditPlan(action.tool)) {
    const workflow = await editWorkflow.get();
    if (!workflow.plan) {
      return toolFailure({
        content:
          "Workspace file edits require an edit plan first. Call editPlan with a concise summary, expectedFiles, and steps before retrying this edit.",
        errorCode: "EDIT_PLAN_REQUIRED",
        retryable: true,
        metadata: { toolName: action.tool }
      });
    }
  }

  // Auto-approve based on permission mode
  if (tool && shouldAutoApproveTool(tool.sideEffect, ctx.permissionMode)) {
    // Even in auto-approve mode, check for sensitive paths and delete commands
    const hasDelete = action.tool === "shell" && shellCommandIsDelete(action);
    if (tool.sideEffect !== "read" && (isWriteTargetingSensitivePath(action) || hasDelete)) {
      // Fall through to confirmation
    } else {
      return runRegisteredTool(availableTools, action.tool, action.input, ctx);
    }
  }

  if (!tool || tool.sideEffect === "read" || ctx.readonly) {
    return runRegisteredTool(availableTools, action.tool, action.input, ctx);
  }

  if (shouldAutoDenyConfirmation(ctx.permissionMode)) {
    return toolFailure({
      content: `Permission mode dontAsk auto-denied tool call ${tool?.name ?? action.tool}.`,
      errorCode: "CONFIRMATION_AUTO_DENIED",
      retryable: false,
      metadata: { toolName: tool?.name ?? action.tool, sideEffect: tool?.sideEffect, input: action.input }
    });
  }

  const request = await buildToolConfirmationRequest(tool, action.input, ctx);
  const approved = options.confirmToolCall ? await options.confirmToolCall(request) : false;
  if (!approved) {
    return {
      ok: false,
      content: `User rejected tool call ${tool.name}.`,
      errorCode: "CONFIRMATION_REJECTED",
      retryable: false,
      metadata: request
    };
  }

  return runRegisteredTool(availableTools, action.tool, action.input, ctx);
}

function shellCommandIsDelete(action: AgentActionOutput): boolean {
  const cmd = extractShellCommand(action.input);
  if (!cmd) return false;
  const assessment = assessShellCommand(cmd, { shellDenylist: [], allowHighRiskShell: true });
  return assessment.errorCode === "SHELL_DELETE_WARNING";
}

function isWriteTargetingSensitivePath(action: AgentActionOutput): boolean {
  if (!action.input || typeof action.input !== "object") return false;
  const input = action.input as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path : undefined;
  if (!path) return false;
  return isSensitivePath(path);
}

async function buildProjectContext(cwd: string, memoryDir: string): Promise<ProjectContextInfo> {
  try {
    const result = await scanProjectWithCache(cwd, { maxDepth: 2, maxFiles: 120, memoryDir });
    const text = [
      `Project index cache: ${result.cacheHit ? "hit" : "miss"}`,
      `Project summary: ${result.summaryPath ?? "<not persisted>"}`,
      summarizeText(formatProjectScan(result.scan), 7000)
    ].join("\n");
    return { text, suggestedChecks: result.scan.suggestedChecks };
  } catch (error) {
    return { text: `Project scan failed: ${(error as Error).message}`, suggestedChecks: [] };
  }
}

export function shouldRequireEditsBeforeFinal(userTask: string, state: Pick<EditWorkflowState, "plan" | "changedFiles">): boolean {
  if (state.changedFiles.length > 0) {
    return false;
  }

  return isCodingChangeTask(userTask);
}

// isCodingChangeTask imported from workflow-guard.ts

async function recordEditWorkflowEffect(
  editWorkflow: EditWorkflowStore,
  action: AgentActionOutput,
  toolResult: ToolResult,
  suggestedChecks: string[]
): Promise<void> {
  await editWorkflow.recordChangedFiles(action, toolResult);

  if (action.tool !== "shell") {
    return;
  }

  const command = extractShellCommand(action.input);
  if (command && isVerificationCheckCommand(command, suggestedChecks)) {
    await editWorkflow.recordCheck(command, toolResult);
  }
}

async function completeEditWorkflow(params: {
  availableTools: ToolDefinition[];
  actionStore: ActionStore;
  editWorkflow: EditWorkflowStore;
  projectContext: ProjectContextInfo;
  ctx: ToolContext;
  options: RunAgentOptions;
  logger: RunLogger;
  step: number;
  canRepair: boolean;
}): Promise<{
  workflowState: EditWorkflowState;
  gitDiffSummary?: string;
  repairObservation?: string;
  action: AgentActionOutput;
  toolCalls: number;
}> {
  let workflowState = await params.editWorkflow.get();
  let toolCalls = 0;
  const fallbackAction: AgentActionOutput = {
    type: "action",
    thought: "No automatic workflow action was needed.",
    tool: "none",
    input: {}
  };

  if (workflowState.changedFiles.length > 0 && !hasCheckAfterLatestChange(workflowState)) {
    const command = pickPythonSyntaxCheckCommand(workflowState) ?? pickCheckCommand(params.projectContext.suggestedChecks);
    if (command) {
      const action: AgentActionOutput = {
        type: "action",
        thought: "Run the project check automatically after workspace edits.",
        tool: "shell",
        input: { command, timeoutMs: 120000 }
      };
      toolCalls += 1;
      await params.logger.write({ event: "auto_check_start", step: params.step, data: { action } });
      const toolResult = await maybeConfirmAndRunTool(
        params.availableTools,
        action,
        params.ctx,
        params.options,
        params.editWorkflow
      );
      const observation = formatToolResultForObservation(toolResult);
      await params.logger.write({ event: "auto_check_result", step: params.step, data: { action, toolResult, observation } });
      await params.actionStore.save({
        thought: action.thought,
        toolName: action.tool,
        toolInput: action.input,
        toolResult,
        observation,
        summary: summarizeObservation(observation)
      });
      await recordEditWorkflowEffect(params.editWorkflow, action, toolResult, params.projectContext.suggestedChecks);
      workflowState = await params.editWorkflow.get();

      if (!toolResult.ok && toolResult.errorCode !== "CONFIRMATION_REJECTED" && params.canRepair) {
        return {
          workflowState,
          repairObservation: `Automatic check failed after edits.\nCommand: ${command}\nObservation:\n${observation}\nPlease inspect the failure, make a focused repair, and finish again.`,
          action,
          toolCalls
        };
      }
    }
  }

  const latestCheck = latestVerificationCheckAfterLatestChange(workflowState);
  if (latestCheck && !latestCheck.ok && params.canRepair) {
    return {
      workflowState,
      repairObservation: `Latest project check failed after edits.\nCommand: ${latestCheck.command}\nError code: ${
        latestCheck.errorCode ?? "unknown"
      }\nPlease inspect the failure, make a focused repair, and finish again.`,
      action: {
        type: "action",
        thought: "The latest project check failed; the agent should repair once.",
        tool: "shell",
        input: { command: latestCheck.command }
      },
      toolCalls
    };
  }

  return {
    workflowState,
    gitDiffSummary: await getGitDiffSummary(params.ctx.cwd),
    action: fallbackAction,
    toolCalls
  };
}

function hasCheckAfterLatestChange(state: EditWorkflowState): boolean {
  return latestVerificationCheckAfterLatestChange(state) !== undefined;
}

function pickPythonSyntaxCheckCommand(state: EditWorkflowState): string | undefined {
  const changedPythonFiles = [
    ...new Set(
      state.changedFiles
        .map((item) => normalizeProjectPath(item.path))
        .filter((path) => path.endsWith(".py"))
    )
  ];
  if (changedPythonFiles.length === 0) {
    return undefined;
  }
  return `python -m py_compile ${changedPythonFiles.map(quoteShellArg).join(" ")}`;
}

function quoteShellArg(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function latestCheckAfterLatestChange(state: EditWorkflowState): EditWorkflowState["checks"][number] | undefined {
  if (state.changedFiles.length === 0) {
    return undefined;
  }
  const changeTimes = state.changedFiles.map((item) => Date.parse(item.timestamp)).filter(Number.isFinite);
  if (changeTimes.length === 0) {
    return state.checks[state.checks.length - 1];
  }

  const latestChange = Math.max(...changeTimes);
  return state.checks
    .filter((item) => Date.parse(item.timestamp) >= latestChange)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
}

function latestVerificationCheckAfterLatestChange(state: EditWorkflowState): EditWorkflowState["checks"][number] | undefined {
  const latestCheck = latestCheckAfterLatestChange({
    ...state,
    checks: state.checks.filter((check) => isVerificationCheckCommand(check.command, []))
  });
  return latestCheck;
}

function isVerificationCheckCommand(command: string, suggestedChecks: string[]): boolean {
  if (isShellEnvironmentSetupCommand(command)) {
    return false;
  }
  return isShellCheckCommand(command, suggestedChecks) && isShellVerificationCommand(command);
}

function appendWorkflowSummary(answer: string, state: EditWorkflowState, gitDiffSummary?: string): string {
  if (!state.plan && state.changedFiles.length === 0 && state.checks.length === 0) {
    return answer;
  }
  return `${answer}\n${formatEditWorkflowSummary(state, gitDiffSummary)}`;
}

export function assessFinalCompletion(
  userTask: string,
  answer: string,
  state: Pick<EditWorkflowState, "plan" | "changedFiles" | "checks">,
  options: { workspaceChangedFiles?: string[]; duplicateTestFunctions?: DuplicatePythonTestFunction[] } = {}
): { ok: true } | { ok: false; message: string; reasons: string[] } {
  if (!isCodingChangeTask(userTask)) {
    return { ok: true };
  }

  const reasons: string[] = [];
  const changed = new Set([
    ...state.changedFiles.map((item) => normalizeProjectPath(item.path)),
    ...(options.workspaceChangedFiles ?? []).map((item) => normalizeProjectPath(item))
  ]);

  if (state.changedFiles.length === 0) {
    reasons.push("No changed files were recorded.");
  }

  if (state.changedFiles.length > 0 && state.checks.length === 0) {
    reasons.push("No verification checks were run after edits.");
  } else if (state.changedFiles.length > 0 && !hasPassingCheckAfterLatestChangeForCompletion(state)) {
    reasons.push("No verification checks passed after edits.");
  }

  if (
    taskRequiresPytest(userTask) &&
    state.changedFiles.length > 0 &&
    !hasPassingCheckAfterLatestChange(state, (command) => /\bpytest\b/i.test(command))
  ) {
    reasons.push("No pytest check passed after the latest edits.");
  }

  if (answerLooksIncomplete(answer)) {
    reasons.push("The final answer says the task is incomplete or requires manual follow-up.");
  }

  if (options.duplicateTestFunctions && options.duplicateTestFunctions.length > 0) {
    reasons.push(
      `Duplicate Python test function definitions found: ${options.duplicateTestFunctions
        .map((item) => `${item.path}:${item.name} at lines ${item.lines.join(", ")}`)
        .join("; ")}. Keep one definition, preferably the last/current expected version, and remove earlier duplicate definitions before final.`
    );
  }

  if (reasons.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    reasons,
    message: `Task is not considered complete.\n${reasons.map((reason) => `- ${reason}`).join("\n")}`
  };
}

function normalizeProjectPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function getDuplicatePythonTestFunctions(cwd: string, changedFiles: string[]): Promise<DuplicatePythonTestFunction[]> {
  const uniqueTestFiles = [
    ...new Set(changedFiles.map((item) => normalizeProjectPath(item)).filter((item) => isPythonTestPath(item)))
  ];
  const duplicates: DuplicatePythonTestFunction[] = [];

  for (const path of uniqueTestFiles) {
    try {
      const content = await readFile(join(cwd, path), "utf8");
      duplicates.push(...findDuplicatePythonTestFunctions(path, content));
    } catch {
      // Ignore deleted or unreadable files; git/test checks will surface real failures.
    }
  }

  return duplicates;
}

function isPythonTestPath(path: string): boolean {
  const normalized = normalizeProjectPath(path);
  return normalized.endsWith(".py") && /(^|\/)(test_[^/]+\.py|[^/]+_test\.py)$/.test(normalized);
}

export function findDuplicatePythonTestFunctions(path: string, content: string): DuplicatePythonTestFunction[] {
  const locations = new Map<string, number[]>();
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = /^def\s+(test_[A-Za-z0-9_]+)\s*\(/.exec(line);
    if (!match) {
      return;
    }
    const existing = locations.get(match[1]) ?? [];
    existing.push(index + 1);
    locations.set(match[1], existing);
  });

  return [...locations.entries()]
    .filter(([, testLines]) => testLines.length > 1)
    .map(([name, testLines]) => ({ path, name, lines: testLines }));
}

function hasPassingCheckAfterLatestChangeForCompletion(
  state: Pick<EditWorkflowState, "changedFiles" | "checks">
): boolean {
  return hasPassingCheckAfterLatestChange(state);
}

function hasPassingCheckAfterLatestChange(
  state: Pick<EditWorkflowState, "changedFiles" | "checks">,
  commandPredicate: (command: string) => boolean = () => true
): boolean {
  if (state.changedFiles.length === 0 || state.checks.length === 0) {
    return false;
  }

  const changeTimes = state.changedFiles.map((item) => Date.parse(item.timestamp)).filter(Number.isFinite);
  const eligibleChecks = state.checks.filter(
    (item) => isVerificationCheckCommand(item.command, []) && item.ok && commandPredicate(item.command)
  );
  if (changeTimes.length === 0) {
    return eligibleChecks.length > 0;
  }

  const latestChange = Math.max(...changeTimes);
  return eligibleChecks.some((item) => Date.parse(item.timestamp) >= latestChange);
}

function taskRequiresPytest(userTask: string): boolean {
  return /\bpytest\b/i.test(userTask);
}

async function getGitDiffSummary(cwd: string): Promise<string | undefined> {
  const [status, diffStat] = await Promise.all([
    runGit(["status", "--short"], cwd),
    runGit(["diff", "--stat", "--"], cwd)
  ]);
  const parts = [];
  if (status.exitCode === 0 && status.stdout.trim()) {
    parts.push("git status --short:", status.stdout.trim());
  }
  if (diffStat.exitCode === 0 && diffStat.stdout.trim()) {
    parts.push("git diff --stat:", diffStat.stdout.trim());
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

async function getGitChangedFiles(cwd: string): Promise<string[]> {
  const status = await runGit(["status", "--porcelain", "--untracked-files=no"], cwd);
  if (status.exitCode !== 0 || !status.stdout.trim()) {
    return [];
  }

  return status.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((line) => {
      const renameTarget = line.split(" -> ").at(-1);
      return renameTarget ?? line;
    });
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ stdout, stderr: `${stderr}${error.message}`, exitCode: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function buildPrompt(
  userTask: string,
  history: AgentHistoryItem[],
  availableTools: ToolDefinition[],
  projectContext: string,
  modelContext: string,
  options: { finalTurn?: boolean; step?: number; maxSteps?: number; workflowState?: EditWorkflowState } = {}
): string {
  const compactHistory = compactHistoryForPrompt(history);
  const historyText =
    compactHistory.length === 0
      ? "No prior turns."
      : compactHistory
          .map(
            (item, index) => `Turn ${index + 1}
Thought: ${item.thought}
Action: ${item.action.tool} ${formatActionInputForPrompt(item.action)}
Observation:
${summarizeObservation(item.observation)}`
          )
          .join("\n\n");

  const parts = [
    `User task:\n${userTask}`,
    `Model context:\n${modelContext}`,
    `Project context:\n${projectContext}`,
    `Available tools:\n${getToolDescriptions(availableTools)}`,
    buildStageGuidance(userTask, { ...options, history }),
    `History:\n${historyText}`
  ];
  const budget = getContextBudget(parts);

  return `${parts.join("\n\n")}

Context budget estimate:
${JSON.stringify(budget)}

Protocol:
- Think step by step internally, but only output strict JSON.
- For coding tasks, inspect the relevant files before editing.
- Before writeFile, appendFile, appendToFile, replaceText, insertText, replaceLines, insertAtLine, or applyPatch, call editPlan with the planned change, likely expectedFiles, and steps. expectedFiles is a narrow candidate list, not a checklist to satisfy with cosmetic edits.
- If the user explicitly mentions editPlan or asks to call it first, the very first action must be editPlan. Do not inspect files before that.
- Prefer replaceLines, insertAtLine, appendToFile, replaceText, or insertText for small targeted edits. Use applyPatch for multi-line code changes, and writeFile only when replacing or creating a whole file is appropriate.
- Do not guess high line numbers for replaceLines/insertAtLine. Read a focused range around that line first, or use an exact text replacement/patch anchor.
- Do not use shell scripts to edit workspace files. Use dedicated edit tools so changes are tracked.
- For multi-step coding tasks, use taskAdd/taskList/taskUpdate to track progress when helpful.
- After edits, the CLI may automatically run a suggested project check and ask you to repair once if it fails.
- If a write or execute tool is rejected by confirmation, explain what would be needed or choose a read-only alternative.
- After edits, run a suitable check command when available.
- Once a relevant verification command passes after the latest edit, do not make extra cosmetic edits just to touch planned files; finish.
- If a verification command fails, do not rerun the identical command until after a repair edit. First read the edited region (using a ranged readFile) to confirm what actually changed, compare the actual file state against the test failure's Expected/Actual or traceback, and only then make a focused repair edit. You can also run "git diff" to review your changes quickly.
- On Windows, this shell runs through cmd.exe. Use cmd-compatible syntax such as "cd /d C:\\path && command"; avoid PowerShell-only cmdlets like Select-Object, Select-String, and Out-File, and avoid Unix-only commands such as tail.
- For Python pytest checks on Windows, prefer an interpreter that already has pytest. If "python -m pytest" resolves to ".venv" and reports "No module named pytest", try "py -m pytest" or another available interpreter before installing packages; install dependencies only when no existing interpreter can run the requested check.
- For Python warning/logging changes, reuse the project's existing console/logging method names and message style. Do one targeted search for existing warning/logging calls before inventing a new API or importing Python's warnings module.
- For realtime, latest, news, scores, prices, weather, or web-page questions, use an MCP search/browser/fetch tool first. If none is available, say that network search is not configured.
- ${
    options.finalTurn
      ? "This is the final allowed turn. Do not call tools. Output a final answer now, summarizing what is known, what remains uncertain, and the next recommended command if more work is needed."
      : "Call tools only while they are needed; once you have enough evidence to answer, output final immediately."
  }
- Answer in the same natural language as the user's task unless the user asks otherwise.
- Write every action "thought" in English. Only the final "answer" should follow the user's requested answer language.
- For fix, repair, implementation, or modification tasks, do not finish with analysis only. Use editPlan and make the focused code change before final.
- To call a tool, output:
{"type":"action","thought":"why this tool is needed","tool":"toolName","input":{}}
- To finish, output:
{"type":"final","answer":"final answer for the user"}
- Do not output Markdown fences, comments, or extra text outside JSON.
`;
}

function buildStageGuidance(
  userTask: string,
  options: { finalTurn?: boolean; step?: number; maxSteps?: number; workflowState?: EditWorkflowState; history?: AgentHistoryItem[] }
): string {
  const step = options.step ?? 1;
  const maxSteps = options.maxSteps ?? defaultMaxStepsFor(userTask);
  const remaining = Math.max(0, maxSteps - step);
  const workflow = options.workflowState;
  const lines = [
    "Stage guidance:",
    `- Step ${step}/${maxSteps}; remaining tool turns after this one: ${remaining}.`
  ];

  if (!isCodingChangeTask(userTask) || !workflow) {
    lines.push("- This task may be answered once enough evidence has been gathered.");
    return lines.join("\n");
  }

  const navigation = navigateWorkflow(userTask, workflow, options.history ?? [], step, maxSteps);
  const policy = workflowPolicyForNavigation(navigation);
  const profile = workflowProfileForTask(userTask, maxSteps);
  const recentPolicyBlocks = countRecentWorkflowGuardBlocks(options.history ?? [], "STAGE_INTENT_BLOCKED");
  lines.push(`- Workflow stage: ${navigation.stage}.`);
  lines.push(`- Recommended next action: ${navigation.recommendedAction}`);
  lines.push(`- Allowed action intents now: ${formatAllowedIntentsForPrompt(policy.allowedIntents)}.`);
  if (profile.kind === "issue-fix") {
    const issueHints = issueFixPromptHints(userTask);
    lines.push(
      `- Issue-fix profile: locate named target/test first, inspect only adjacent code, make the smallest behavioral edit, run the targeted regression check, then final.`
    );
    lines.push(`- Issue-fix budgets: pre-edit inspect ${profile.explorationBudget} turns; post-edit inspect ${profile.postEditExplorationBudget} turns; target miss limit ${profile.targetMissLimit}.`);
    if (issueHints.length > 0) {
      lines.push(`- Issue-fix hints: ${issueHints.join(" | ")}. Search exact target symbols before broader exploration.`);
    }
  }
  if (navigation.reasons.length > 0) {
    lines.push(`- Reason: ${navigation.reasons.join(" ")}`);
  }
  if (navigation.blockedActions.length > 0) {
    lines.push(`- Avoid now: ${navigation.blockedActions.join(", ")}.`);
  }

  if (workflow.plan) {
    lines.push(`- Edit plan exists. Likely files: ${workflow.plan.expectedFiles.join(", ") || "none listed"}.`);
  }
  if (workflow.changedFiles.length > 0) {
    lines.push(`- Changed files recorded: ${workflow.changedFiles.map((item) => item.path).join(", ")}.`);
  }
  if (recentPolicyBlocks > 0) {
    lines.push(`- Recent workflow guard blocks: ${recentPolicyBlocks}. The next action must use one of the allowed intents above.`);
  }

  if (remaining <= 2) {
    lines.push("- Low step budget. Avoid new broad exploration; finish the smallest complete path or clearly report incomplete work.");
  }

  return lines.join("\n");
}
