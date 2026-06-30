import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ActionStore } from "./action-store.js";
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
import { inferModelProfile, modelProfileForPrompt } from "./model-adapter.js";
import { formatProjectScan, scanProjectWithCache } from "./project-scan.js";
import { RunLogger } from "./run-log.js";
import { defaultSecurityPolicy } from "./security.js";
import { summarizeObservation, summarizeText } from "./summary.js";
import { formatToolResultForObservation, toolFailure } from "./tool-result.js";
import { buildToolConfirmationRequest } from "./tool-preview.js";
import { runRegisteredTool } from "./tool-scheduler.js";
import type {
  AgentActionOutput,
  AgentFinalOutput,
  AgentHistoryItem,
  AgentOutput,
  ToolConfirmationRequest,
  ToolContext,
  ToolDefinition,
  ToolResult,
  SecurityPolicy
} from "./types.js";
import { getToolDescriptions, tools as localTools } from "./tools/registry.js";

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
  securityPolicy?: SecurityPolicy;
  confirmToolCall?: (request: ToolConfirmationRequest) => Promise<boolean>;
};

export type RunAgentResult = {
  answer: string;
  status: "completed" | "failed" | "max_steps";
  runId: string;
  logPath: string;
  stepsUsed: number;
  toolCalls: number;
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
  const ctx: ToolContext = {
    cwd,
    memoryDir,
    readonly: options.readonly ?? false,
    runId,
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
    return {
      answer,
      status: "failed",
      runId: logger.runId,
      logPath: logger.filePath,
      stepsUsed,
      toolCalls
    };
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
        return {
          answer,
          status: "failed",
          runId: logger.runId,
          logPath: logger.filePath,
          stepsUsed,
          toolCalls
        };
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
        return {
          answer,
          status: "failed",
          runId: logger.runId,
          logPath: logger.filePath,
          stepsUsed,
          toolCalls
        };
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
        return {
          answer,
          status: "failed",
          runId: logger.runId,
          logPath: logger.filePath,
          stepsUsed,
          toolCalls
        };
      }

      await logger.write({ event: "final", step, data: { answer } });
      await logger.write({ event: "run_end", data: { status: "completed", answer } });
      return {
        answer,
        status: "completed",
        runId: logger.runId,
        logPath: logger.filePath,
        stepsUsed,
        toolCalls
      };
    }

    if (isFinalTurn) {
      const attempted = parsed.value;
      const answer =
        attempted.type === "action"
          ? `Reached final turn before completion. The model attempted another tool call (${attempted.tool}) instead of summarizing. Last thought: ${attempted.thought}`
          : "Reached final turn before completion.";
      await logger.write({ event: "final_turn_action_blocked", step, data: { attempted, answer } });
      await logger.write({ event: "run_end", data: { status: "max_steps", answer } });
      return {
        answer,
        status: "max_steps",
        runId: logger.runId,
        logPath: logger.filePath,
        stepsUsed,
        toolCalls
      };
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
  return {
    answer,
    status: "max_steps",
    runId: logger.runId,
    logPath: logger.filePath,
    stepsUsed,
    toolCalls
  };
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

  if (!tool || tool.sideEffect === "read" || ctx.readonly || options.autoConfirm) {
    return runRegisteredTool(availableTools, action.tool, action.input, ctx);
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

export function maybeBlockByStageBudget(
  action: AgentActionOutput,
  userTask: string,
  step: number,
  maxSteps: number,
  workflow: EditWorkflowState,
  history: AgentHistoryItem[] = []
): ToolResult | undefined {
  if (!isCodingChangeTask(userTask)) {
    const analysisExplorationTools = new Set([...explorationToolNames(), "shell"]);
    const isMcpTool = action.tool.startsWith("mcp_");
    const consecutiveAnalysis = countConsecutiveExplorationTurns(history, analysisExplorationTools);
    const totalAnalysisExplore = consecutiveAnalysis + (isMcpTool || explorationToolNames().has(action.tool) ? 1 : 0);
    if (totalAnalysisExplore >= 4 && (explorationToolNames().has(action.tool) || isMcpTool || action.tool === "shell")) {
      return toolFailure({
        content:
          "You've gathered information for several turns in a row. Stop exploring or searching now; provide a final answer based on the evidence already collected.",
        errorCode: "ANALYSIS_EXPLORATION_LIMIT",
        retryable: true,
        metadata: { step, maxSteps, toolName: action.tool }
      });
    }
    return undefined;
  }

  const navigation = navigateWorkflow(userTask, workflow, history, step, maxSteps);
  const actionIntent = classifyActionIntent(action);
  const editFailureRecovery = detectEditFailureRecoveryInspection(action, history);

  if (taskRequestsEditPlanFirst(userTask) && !workflow.plan && action.tool !== "editPlan") {
    return toolFailure({
      content:
        "The user explicitly requested calling editPlan first. Call editPlan now with a concise summary, expectedFiles, and steps before any further inspection or edits.",
      errorCode: "EDIT_PLAN_REQUIRED_FIRST",
      retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  if (workflow.plan && action.tool === "editPlan") {
    return toolFailure({
      content:
        "An edit plan already exists. Do not recreate the plan; continue with the next concrete edit, verification check, or final answer.",
      errorCode: "EDIT_PLAN_ALREADY_EXISTS",
      retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const fakeEdit = detectFakeProgressEdit(action);
  if (workflow.plan && workflow.changedFiles.length === 0 && fakeEdit) {
    return toolFailure({
      content:
        `${fakeEdit} Do not make temporary, dummy, or no-op edits to bypass exploration limits. Make the real planned code/test edit now, using the last observed line numbers or an exact anchor from history.`,
      errorCode: "FAKE_PROGRESS_EDIT_BLOCKED",
      retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const assertionWeakening = detectTestAssertionWeakening(action, userTask);
  if (assertionWeakening) {
    return toolFailure({
      content: assertionWeakening,
      errorCode: "TEST_ASSERTION_WEAKENING_BLOCKED",
      retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const repeatedFailedEdit = detectRepeatedFailedEditWithoutContext(action, history);
  if (repeatedFailedEdit) {
    return toolFailure({
      content: repeatedFailedEdit,
      errorCode: "EDIT_CONTEXT_REQUIRED",
      retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const repeatedReplaceTextFailure = detectRepeatedReplaceTextFailure(action, history);
  if (repeatedReplaceTextFailure) {
    return toolFailure({
      content: repeatedReplaceTextFailure,
      errorCode: "REPLACE_TEXT_REPEATED_FAILURE",
      retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const unverifiedLineEdit = detectUnverifiedLineEdit(action, history);
  if (unverifiedLineEdit) {
    return toolFailure({
      content: unverifiedLineEdit,
      errorCode: "UNVERIFIED_LINE_EDIT_BLOCKED",
      retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const shellCommand = action.tool === "shell" ? extractShellCommand(action.input) : undefined;
  if (shellCommand && isShellFileEditCommand(shellCommand)) {
    return toolFailure({
      content:
        "Shell commands that write workspace files are blocked for code-change tasks. Use replaceLines, insertAtLine, appendToFile, replaceText, insertText, applyPatch, or writeFile so edits are tracked in the workflow.",
      errorCode: "SHELL_FILE_EDIT_BLOCKED",
      retryable: true,
      metadata: { toolName: action.tool }
    });
  }

  if (
    workflow.changedFiles.length > 0 &&
    isReadyForFinal(userTask, workflow)
  ) {
    return toolFailure({
      content:
        "The task is ready for final: a relevant verification check has passed after the latest edit. Do not call more tools or make cosmetic/requirement-satisfying edits; provide the final answer instead.",
      errorCode: "FINAL_READY_EDIT_BLOCKED",
      retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const latestCheck = latestCheckAfterLatestChange(workflow);
  if (
    shellCommand &&
    latestCheck &&
    !latestCheck.ok &&
    normalizeShellCommandForComparison(shellCommand) === normalizeShellCommandForComparison(latestCheck.command)
  ) {
    return toolFailure({
      content:
        "This same verification command already failed after the latest edit, and no repair edit has been recorded since then. Do not rerun it unchanged. Use the failure output already in history to make a focused repair edit first, then rerun the check.",
      errorCode: "REDUNDANT_FAILED_CHECK_BLOCKED",
      retryable: true,
      metadata: { step, toolName: action.tool, command: shellCommand }
    });
  }

  const riskyImport = detectRiskyPythonTopImport(action);
  if (riskyImport) {
    return toolFailure({
      content:
        `${riskyImport} Read the top of the Python file if needed, then insert normal imports after any module docstring and from __future__ imports. If the task is about emitting a warning, prefer the project's existing console/logging warning API instead of adding Python's warnings module unless you have verified it is already the local pattern.`,
      errorCode: "PYTHON_TOP_IMPORT_BLOCKED",
      retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  if (actionIntent === "setup" && !recentVerificationMissingDependency(history)) {
    return toolFailure({
      content:
        "Environment setup/install commands are blocked until a recent verification failure shows a missing test runner or dependency. Run the relevant check first, then install only the missing dependency if needed.",
      errorCode: "ENV_SETUP_NOT_JUSTIFIED",
      retryable: true,
      metadata: { step, maxSteps, toolName: action.tool }
    });
  }

  const explorationBudget = navigation.explorationBudget;
  const editBudget = Math.max(explorationBudget + 2, Math.ceil(maxSteps * 0.65));
  const broadExploreTools = broadExplorationTools();
  const explorationTools = explorationToolNames();
  const isExploration = actionIntent === "inspect";
  const isTargetedApiLookup = isTargetedConventionLookup(action, userTask);
  const isBroadRead =
    action.tool === "readFile" &&
    (!action.input ||
      typeof action.input !== "object" ||
      (!("startLine" in action.input) && !("lineCount" in action.input) && !("offset" in action.input) && !("limit" in action.input)));

  if (
    workflow.plan &&
    workflow.changedFiles.length === 0 &&
    step > explorationBudget &&
    (broadExploreTools.has(action.tool) || isBroadRead) &&
    !editFailureRecovery
  ) {
    return toolFailure({
      content:
        "Exploration budget is over for this code-change task. Use focused search/ranged read if absolutely needed, otherwise make the planned edit with replaceLines, insertAtLine, appendToFile, replaceText, insertText, applyPatch, or writeFile.",
      errorCode: "EXPLORATION_BUDGET_EXCEEDED",
      retryable: true,
      metadata: { step, maxSteps, explorationBudget, toolName: action.tool }
    });
  }

  const repeatedExploration = countConsecutiveExplorationTurns(history, explorationTools);
  if (
    workflow.plan &&
    workflow.changedFiles.length === 0 &&
    isIssueFixTask(userTask) &&
    countFailedTargetLocationAttempts(history, userTask) >= workflowProfileForTask(userTask, maxSteps).targetMissLimit &&
    isExploration &&
    !editFailureRecovery &&
    !isTargetedApiLookup
  ) {
    return toolFailure({
      content:
        "The requested issue target has not been located after repeated exact searches. Stop exploring and report that the local checkout may not match the issue/tag, including the missing symbols and the command the user should run to verify or switch versions. Do not keep searching unrelated files.",
      errorCode: "TARGET_NOT_LOCATED_PRECHECK_FAILED",
      retryable: true,
      metadata: { step, maxSteps, toolName: action.tool }
    });
  }

  if (
    workflow.plan &&
    workflow.changedFiles.length === 0 &&
    repeatedExploration >= explorationBudget &&
    isExploration &&
    !editFailureRecovery &&
    !isTargetedApiLookup
  ) {
    return toolFailure({
      content:
        "Repeated exploration is blocked before any files have changed for this code-change task. Do not try another read/search/shell command or add dummy edits to bypass this. Make the real planned edit now with replaceLines, insertAtLine, appendToFile, replaceText, insertText, applyPatch, or writeFile, using the line numbers or anchors already shown in history. If the only missing fact is an API name or project convention, make one targeted search for the exact convention such as warning/logging/error method names.",
      errorCode: "REPEATED_EXPLORATION_BLOCKED",
      retryable: true,
      metadata: { step, maxSteps, explorationBudget, repeatedExploration, toolName: action.tool }
    });
  }

  if (
    workflow.plan &&
    workflow.changedFiles.length === 0 &&
    step > explorationBudget + 2 &&
    isExploration &&
    !editFailureRecovery &&
    !isTargetedApiLookup
  ) {
    return toolFailure({
      content:
        "The pre-edit inspection window is over. Stop reading/searching and make the first real planned edit now, using the line numbers and anchors already shown in history.",
      errorCode: "PRE_EDIT_EXPLORATION_WINDOW_CLOSED",
      retryable: true,
      metadata: { step, maxSteps, explorationBudget, toolName: action.tool }
    });
  }

  if (
    workflow.changedFiles.length > 0 &&
    workflow.checks.length === 0 &&
    repeatedExploration >= navigation.postEditExplorationBudget &&
    isExploration
  ) {
    return toolFailure({
      content:
        `Repeated exploration after edits is blocked. ${navigation.recommendedAction} Do not keep rereading the same regions.`,
      errorCode: "POST_EDIT_EXPLORATION_BLOCKED",
      retryable: true,
      metadata: { step, maxSteps, repeatedExploration, toolName: action.tool }
    });
  }

  if (workflow.changedFiles.length > 0 && workflow.checks.length === 0 && step >= editBudget && broadExploreTools.has(action.tool)) {
    return toolFailure({
      content:
        "Verification phase has started after file edits. Run a relevant shell check, make a focused repair, or finish with a clear incomplete status if verification is impossible.",
      errorCode: "VERIFICATION_PHASE_REQUIRED",
      retryable: true,
      metadata: { step, maxSteps, editBudget, toolName: action.tool }
    });
  }

  const policy = workflowPolicyForNavigation(navigation);
  if (!policy.allowedIntents.includes(actionIntent) && !isTargetedApiLookup && !editFailureRecovery) {
    const recentPolicyBlocks = countRecentWorkflowGuardBlocks(history, "STAGE_INTENT_BLOCKED");
    return toolFailure({
      content:
        `${policy.reason} Current workflow stage is "${navigation.stage}". Recommended next action: ${navigation.recommendedAction}\n` +
        `Allowed action intents now: ${formatAllowedIntentsForPrompt(policy.allowedIntents)}.\n` +
        (recentPolicyBlocks > 0
          ? `This is workflow policy violation #${recentPolicyBlocks + 1} in the recent context. Stop trying adjacent tools; choose only an allowed intent next turn.`
          : "Choose only an allowed intent next turn."),
      errorCode: "STAGE_INTENT_BLOCKED",
      retryable: true,
      metadata: { step, maxSteps, stage: navigation.stage, actionIntent, toolName: action.tool, recentPolicyBlocks }
    });
  }

  return undefined;
}

export type WorkflowStage = "analysis" | "plan" | "inspect" | "edit" | "repair-or-verify" | "verify" | "final";

export type ActionIntent = "plan" | "inspect" | "edit" | "verify" | "setup" | "other";

export type WorkflowPolicy = {
  allowedIntents: ActionIntent[];
  reason: string;
};

export function workflowPolicyForNavigation(navigation: Pick<WorkflowNavigation, "stage" | "reasons">): WorkflowPolicy {
  switch (navigation.stage) {
    case "analysis":
      return {
        allowedIntents: ["plan", "inspect", "edit", "verify", "setup", "other"],
        reason: "No coding workflow restrictions apply yet."
      };
    case "plan":
      if (navigation.reasons.some((reason) => /explicitly requested editPlan/i.test(reason))) {
        return {
          allowedIntents: ["plan"],
          reason: "The user explicitly requested editPlan first, so planning is the only allowed action."
        };
      }
      return {
        allowedIntents: ["plan", "inspect"],
        reason: "Before editing, the workflow only allows creating the edit plan or focused inspection."
      };
    case "inspect":
      return {
        allowedIntents: ["inspect", "edit", "verify"],
        reason: "Inspection is open, but unrelated shell/actions are not part of the coding workflow."
      };
    case "edit":
      return {
        allowedIntents: ["edit", "verify", "setup"],
        reason: "The inspection budget is spent; the workflow requires a real edit, one focused verification run, or justified environment setup."
      };
    case "repair-or-verify":
      return {
        allowedIntents: ["inspect", "edit", "verify", "setup"],
        reason: "After edits, only focused inspection, repair edits, or verification are allowed."
      };
    case "verify":
      return {
        allowedIntents: ["edit", "verify", "setup"],
        reason: "The workflow is in verification; run the relevant check or make a repair edit."
      };
    case "final":
      return {
        allowedIntents: [],
        reason: "The workflow is complete and should produce final instead of calling tools."
      };
  }
}

export function formatAllowedIntentsForPrompt(intents: ActionIntent[]): string {
  if (intents.length === 0) {
    return "none; output final instead of calling tools";
  }

  const descriptions: Record<ActionIntent, string> = {
    plan: "plan=editPlan",
    inspect: "inspect=focused read/search/git status only",
    edit: "edit=replaceLines/insertAtLine/replaceText/insertText/applyPatch",
    verify: "verify=pytest/typecheck/py_compile/test command",
    setup: "setup=install/sync only after missing dependency failure",
    other: "other=non-file/non-workflow action"
  };
  return intents.map((intent) => descriptions[intent]).join("; ");
}

export function classifyActionIntent(action: AgentActionOutput): ActionIntent {
  if (action.tool === "editPlan") {
    return "plan";
  }

  if (requiresEditPlan(action.tool)) {
    return "edit";
  }

  if (action.tool === "shell") {
    const command = extractShellCommand(action.input);
    if (!command) {
      return "other";
    }
    if (isShellFileEditCommand(command)) {
      return "edit";
    }
    if (isShellEnvironmentSetupCommand(command)) {
      return "setup";
    }
    if (isShellVerificationCommand(command)) {
      return "verify";
    }
    if (isShellFileReadCommand(command)) {
      return "inspect";
    }
    return "other";
  }

  if (explorationToolNames().has(action.tool)) {
    return "inspect";
  }

  return "other";
}

export type WorkflowNavigation = {
  stage: WorkflowStage;
  recommendedAction: string;
  blockedActions: string[];
  reasons: string[];
  explorationBudget: number;
  postEditExplorationBudget: number;
  repeatedExploration: number;
};

export type WorkflowProfile = {
  kind: "generic" | "issue-fix";
  explorationBudget: number;
  postEditExplorationBudget: number;
  targetMissLimit: number;
};

export function workflowProfileForTask(userTask: string, maxSteps: number): WorkflowProfile {
  if (isIssueFixTask(userTask)) {
    return {
      kind: "issue-fix",
      explorationBudget: taskRequestsEditPlanFirst(userTask) ? 7 : 5,
      postEditExplorationBudget: 2,
      targetMissLimit: 2
    };
  }

  return {
    kind: "generic",
    explorationBudget: taskRequestsEditPlanFirst(userTask) ? 6 : Math.min(6, Math.max(4, Math.ceil(maxSteps * 0.12))),
    postEditExplorationBudget: 4,
    targetMissLimit: 3
  };
}

export function issueFixPromptHints(userTask: string): string[] {
  if (!isIssueFixTask(userTask)) {
    return [];
  }

  const hints: string[] = [];
  const targets = extractIssueTargetTokens(userTask);
  const testPath = extractMentionedTestPath(userTask);
  const classMethod = extractMentionedClassMethod(userTask);
  const testFunction = targets.find((target) => /^test_[A-Za-z0-9_]+$/.test(target));

  if (targets.length > 0) {
    hints.push(`Exact target symbols: ${targets.join(", ")}`);
  }

  if (testPath && classMethod) {
    hints.push(`Targeted pytest candidate: python -m pytest ${testPath}::${classMethod.className}::${classMethod.methodName} -q`);
  } else if (testPath && testFunction) {
    hints.push(`Targeted pytest candidate: python -m pytest ${testPath}::${testFunction} -q`);
  } else if (classMethod) {
    hints.push(`Targeted pytest candidate: python -m pytest -k "${classMethod.className} and ${classMethod.methodName}" -q`);
  } else if (testFunction) {
    hints.push(`Targeted pytest candidate: python -m pytest -k "${testFunction}" -q`);
  }

  return hints;
}

export function navigateWorkflow(
  userTask: string,
  workflow: Pick<EditWorkflowState, "plan" | "changedFiles" | "checks">,
  history: AgentHistoryItem[] = [],
  step = 1,
  maxSteps = 10
): WorkflowNavigation {
  const profile = workflowProfileForTask(userTask, maxSteps);
  const explorationBudget = profile.explorationBudget;
  const afterEditBudget = profile.postEditExplorationBudget;
  const repeatedExploration = countConsecutiveExplorationTurns(history, explorationToolNames());
  const reasons: string[] = [];

  if (!isCodingChangeTask(userTask)) {
    return {
      stage: "analysis",
      recommendedAction: "Gather only the evidence needed, then answer directly.",
      blockedActions: [],
      reasons: ["The user task does not appear to require code changes."],
      explorationBudget,
      postEditExplorationBudget: afterEditBudget,
      repeatedExploration
    };
  }

  if (!workflow.plan) {
    if (taskRequestsEditPlanFirst(userTask)) {
      reasons.push("The user explicitly requested editPlan before other work.");
      return {
        stage: "plan",
        recommendedAction: "Call editPlan now with concise expectedFiles and implementation steps.",
        blockedActions: ["readFile", "searchText", "projectScan", "tree", "listDir", "shell", "final"],
        reasons,
        explorationBudget,
        postEditExplorationBudget: afterEditBudget,
        repeatedExploration
      };
    }

    reasons.push("No edit plan has been recorded for this code-change task.");
    return {
      stage: "plan",
      recommendedAction: "Do one focused inspection if needed, then call editPlan before editing.",
      blockedActions: ["final"],
      reasons,
      explorationBudget,
      postEditExplorationBudget: afterEditBudget,
      repeatedExploration
    };
  }

  if (workflow.changedFiles.length === 0) {
    if (repeatedExploration >= explorationBudget || step > explorationBudget) {
      reasons.push("The pre-edit exploration budget has been spent and no file changes are recorded.");
      return {
        stage: "edit",
        recommendedAction:
          "Make the first real planned edit now with replaceLines, insertAtLine, appendToFile, replaceText, insertText, applyPatch, or writeFile.",
        blockedActions: ["projectScan", "tree", "listDir", "readFile", "searchText", "readTail", "fileExists", "recall", "final"],
        reasons,
        explorationBudget,
        postEditExplorationBudget: afterEditBudget,
        repeatedExploration
      };
    }

    reasons.push("An edit plan exists, but no files have changed yet.");
    return {
      stage: "inspect",
      recommendedAction: `Use only focused search/ranged reads, then edit before ${explorationBudget} consecutive inspection turns.`,
      blockedActions: ["projectScan", "tree", "listDir", "final"],
      reasons,
      explorationBudget,
      postEditExplorationBudget: afterEditBudget,
      repeatedExploration
    };
  }

  if (workflow.checks.length === 0) {
    if (repeatedExploration >= afterEditBudget) {
      reasons.push("Files have changed, but post-edit inspection is repeating without verification.");
      return {
        stage: "verify",
        recommendedAction: "Run the relevant pytest/check command now, or make one focused repair edit if the defect is already clear.",
        blockedActions: ["projectScan", "tree", "listDir", "readFile", "searchText", "readTail", "fileExists", "recall"],
        reasons,
        explorationBudget,
        postEditExplorationBudget: afterEditBudget,
        repeatedExploration
      };
    }

    reasons.push("Files have changed and no verification check has run yet.");
    return {
      stage: "repair-or-verify",
      recommendedAction: "Prefer running the relevant check now; inspect only if a very small missing context is needed.",
      blockedActions: ["projectScan", "tree", "listDir"],
      reasons,
      explorationBudget,
      postEditExplorationBudget: afterEditBudget,
      repeatedExploration
    };
  }

  const latestCheck = latestCheckAfterLatestChange({
    runId: "navigation",
    changedFiles: workflow.changedFiles,
    checks: workflow.checks,
    plan: workflow.plan
  });
  if (latestCheck && !latestCheck.ok) {
    reasons.push("The latest verification after edits failed.");
    return {
      stage: "repair-or-verify",
      recommendedAction: "Repair the failing behavior directly, then rerun the failed check.",
      blockedActions: ["projectScan", "tree", "listDir", "final"],
      reasons,
      explorationBudget,
      postEditExplorationBudget: afterEditBudget,
      repeatedExploration
    };
  }

  if (isReadyForFinal(userTask, workflow)) {
    reasons.push("A verification check passed after the latest recorded edit.");
    return {
      stage: "final",
      recommendedAction: "Finish with a concise final answer in the user's requested language.",
      blockedActions: ["projectScan", "tree", "listDir", "readFile", "searchText", "shell"],
      reasons,
      explorationBudget,
      postEditExplorationBudget: afterEditBudget,
      repeatedExploration
    };
  }

  reasons.push("Checks exist, but none are known to have passed after the latest edit.");
  return {
    stage: "verify",
    recommendedAction: "Run or rerun the most relevant verification command before final.",
    blockedActions: ["projectScan", "tree", "listDir", "final"],
    reasons,
    explorationBudget,
    postEditExplorationBudget: afterEditBudget,
    repeatedExploration
  };
}

function taskRequestsEditPlanFirst(userTask: string): boolean {
  return /\beditPlan\b/.test(userTask);
}

function detectFakeProgressEdit(action: AgentActionOutput): string | undefined {
  if (!action.input || typeof action.input !== "object") {
    return undefined;
  }

  const input = action.input as Record<string, unknown>;
  if (action.tool === "replaceText" && typeof input.search === "string" && input.search === input.replacement) {
    return "This replaceText call would not change the file.";
  }

  const content = typeof input.content === "string" ? input.content : "";
  if (!["appendFile", "appendToFile", "insertText", "insertAtLine", "replaceLines", "writeFile"].includes(action.tool)) {
    return undefined;
  }

  const normalized = content.toLowerCase();
  if (/\b(dummy|temporary|temp|unblock|bypass|exploration|harmless comment)\b/.test(normalized)) {
    return "This edit appears to be temporary or intended only to unblock exploration.";
  }

  return undefined;
}

function detectTestAssertionWeakening(action: AgentActionOutput, userTask: string): string | undefined {
  if (!isIssueFixTask(userTask) || !action.input || typeof action.input !== "object") {
    return undefined;
  }

  const input = action.input as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path.replaceAll("\\", "/") : "";
  if (!/(^|\/)tests?\//.test(path) && !/(^|\/)test_[^/]+\.py$/.test(path) && !/(^|\/)[^/]+_test\.py$/.test(path)) {
    return undefined;
  }

  const search = typeof input.search === "string" ? input.search : "";
  const replacement = typeof input.replacement === "string" ? input.replacement : typeof input.content === "string" ? input.content : "";
  const removesAssertion = /\b(assert|AssertionError|pytest\.raises|self\.assert[A-Z]\w*)\b/.test(search);
  const keepsAssertion = /\b(assert|AssertionError|pytest\.raises|self\.assert[A-Z]\w*)\b/.test(replacement);
  const commentOnly = replacement
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .every((line) => line.startsWith("#"));

  if (removesAssertion && (!keepsAssertion || commentOnly)) {
    return "This edit weakens or removes a test assertion for an issue-fix task. Fix the behavior under test or replace the assertion with an equivalent stronger check; do not make tests pass by deleting the oracle.";
  }

  return undefined;
}

function detectRepeatedFailedEditWithoutContext(action: AgentActionOutput, history: AgentHistoryItem[]): string | undefined {
  const path = extractEditPath(action);
  if (!path) {
    return undefined;
  }

  const recent = history.slice(-10);
  const failedEditCount = recent.filter((item) => {
    if (extractEditPath(item.action) !== path) {
      return false;
    }
    return /\b(TEXT_NOT_FOUND|UNVERIFIED_LINE_EDIT_BLOCKED|PYTHON_TOP_IMPORT_BLOCKED|FAKE_PROGRESS_EDIT_BLOCKED)\b/.test(item.observation);
  }).length;

  if (failedEditCount < 2 || hasSuccessfulRecentReadOfPath(recent, path)) {
    return undefined;
  }

  return `Recent edit attempts against ${path} failed because the current context was not anchored. Do not try another edit on that file yet; first read a focused range or search an exact symbol in ${path}, then make one anchored edit.`;
}

function detectRepeatedReplaceTextFailure(action: AgentActionOutput, history: AgentHistoryItem[]): string | undefined {
  if (action.tool !== "replaceText") {
    return undefined;
  }

  const path = extractEditPath(action);
  if (!path) {
    return undefined;
  }

  const recent = history.slice(-12);
  let failedCount = 0;
  for (const item of recent) {
    if (item.action.tool !== "replaceText") {
      continue;
    }
    if (extractEditPath(item.action) !== path) {
      continue;
    }
    if (/\bTEXT_NOT_FOUND\b/.test(item.observation)) {
      failedCount += 1;
    }
  }

  if (failedCount < 3) {
    return undefined;
  }

  return (
    `You've tried replaceText on ${path} ${failedCount} times in recent history and all failed with TEXT_NOT_FOUND. ` +
    `The search patterns you are providing do not match the current file content. ` +
    `Read a focused range of the file (using startLine/lineCount) to get exact line numbers, ` +
    `then use replaceLines instead.`
  );
}

function detectEditFailureRecoveryInspection(action: AgentActionOutput, history: AgentHistoryItem[]): boolean {
  if (!["readFile", "searchText"].includes(action.tool) || !action.input || typeof action.input !== "object") {
    return false;
  }

  const failedPath = latestFailedEditPath(history);
  if (!failedPath) {
    return false;
  }

  const input = action.input as Record<string, unknown>;
  if (action.tool === "readFile") {
    const path = typeof input.path === "string" ? normalizeProjectPath(input.path) : "";
    const hasRange = "startLine" in input || "lineCount" in input || "offset" in input || "limit" in input;
    return path === failedPath && hasRange;
  }

  const root = typeof input.root === "string" ? normalizeProjectPath(input.root) : "";
  const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
  return pattern.length >= 3 && (root === failedPath || root === "." || root === "");
}

function latestFailedEditPath(history: AgentHistoryItem[]): string | undefined {
  for (const item of history.slice(-8).reverse()) {
    const path = extractEditPath(item.action);
    if (path && /\b(TEXT_NOT_FOUND|UNVERIFIED_LINE_EDIT_BLOCKED|EDIT_CONTEXT_REQUIRED)\b/.test(item.observation)) {
      return path;
    }
  }
  return undefined;
}

function extractEditPath(action: AgentActionOutput): string | undefined {
  if (
    !["writeFile", "appendFile", "appendToFile", "replaceText", "insertText", "replaceLines", "insertAtLine"].includes(action.tool) ||
    !action.input ||
    typeof action.input !== "object"
  ) {
    return undefined;
  }

  const path = (action.input as Record<string, unknown>).path;
  return typeof path === "string" ? normalizeProjectPath(path) : undefined;
}

function hasSuccessfulRecentReadOfPath(history: AgentHistoryItem[], path: string): boolean {
  return history.some((item) => {
    if (item.action.tool !== "readFile" || !item.action.input || typeof item.action.input !== "object") {
      return false;
    }
    if (/\[tool_error\]|code:\s*[A-Z_]+/i.test(item.observation)) {
      return false;
    }
    const readPath = (item.action.input as Record<string, unknown>).path;
    return typeof readPath === "string" && normalizeProjectPath(readPath) === path;
  });
}

function detectUnverifiedLineEdit(action: AgentActionOutput, history: AgentHistoryItem[]): string | undefined {
  if (!["replaceLines", "insertAtLine"].includes(action.tool) || !action.input || typeof action.input !== "object") {
    return undefined;
  }

  const input = action.input as Record<string, unknown>;
  const path = typeof input.path === "string" ? normalizeProjectPath(input.path) : "";
  const lineValue = action.tool === "replaceLines" ? input.startLine : input.line;
  const line = typeof lineValue === "number" ? lineValue : Number(lineValue);
  if (!path || !Number.isFinite(line) || line < 120) {
    return undefined;
  }

  if (hasRecentLineContext(history, path, line)) {
    return undefined;
  }

  return `This ${action.tool} targets ${path}:${line}, but that line range has not been read successfully in recent history. Do not guess high line numbers; read a focused range around the target line or use an exact text replacement/patch anchor first.`;
}

function hasRecentLineContext(history: AgentHistoryItem[], path: string, line: number): boolean {
  return history.slice(-12).some((item) => {
    if (item.action.tool !== "readFile" || !item.action.input || typeof item.action.input !== "object") {
      return false;
    }
    if (/\[tool_error\]|code:\s*[A-Z_]+/i.test(item.observation)) {
      return false;
    }

    const input = item.action.input as Record<string, unknown>;
    const readPath = typeof input.path === "string" ? normalizeProjectPath(input.path) : "";
    if (readPath !== path) {
      return false;
    }

    const startValue = input.startLine ?? input.offset;
    const countValue = input.lineCount ?? input.limit;
    const startLine = typeof startValue === "number" ? startValue : Number(startValue);
    const lineCount = typeof countValue === "number" ? countValue : Number(countValue);
    if (!Number.isFinite(startLine) || !Number.isFinite(lineCount) || lineCount <= 0) {
      return false;
    }

    const endLine = startLine + lineCount - 1;
    return line >= startLine - 2 && line <= endLine + 2;
  });
}

function detectRiskyPythonTopImport(action: AgentActionOutput): string | undefined {
  if (action.tool !== "insertAtLine" || !action.input || typeof action.input !== "object") {
    return undefined;
  }

  const input = action.input as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path : "";
  const line = typeof input.line === "number" ? input.line : Number(input.line);
  const content = typeof input.content === "string" ? input.content.trimStart() : "";
  if (!path.endsWith(".py") || line !== 1 || !/^import\s+|^from\s+(?!__future__\b)/.test(content)) {
    return undefined;
  }

  return "This insertAtLine call would add a normal import at the first line of a Python file, which can break files that start with a module docstring or from __future__ imports.";
}

function isTargetedConventionLookup(action: AgentActionOutput, userTask: string): boolean {
  if (!/\b(warn|warning|log|logging|error|diagnostic)\b/i.test(userTask)) {
    return false;
  }
  if (action.tool !== "searchText" || !action.input || typeof action.input !== "object") {
    return false;
  }

  const input = action.input as Record<string, unknown>;
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const root = typeof input.root === "string" ? input.root.replaceAll("\\", "/") : "";
  const isConventionPattern = /\b(warn|warning|console\.warning|logger|logging|def warning|def warn)\b/i.test(pattern);
  const isFocusedRoot =
    root.length > 0 &&
    root !== "." &&
    !root.endsWith("/") &&
    !/\b(node_modules|\.git|dist|build|site-packages)\b/.test(root);
  return isConventionPattern && isFocusedRoot;
}

function isIssueFixTask(userTask: string): boolean {
  return /\bissue\s*#?\d+\b|#[0-9]{2,}\b/i.test(userTask);
}

function countFailedTargetLocationAttempts(history: AgentHistoryItem[], userTask: string): number {
  const targets = extractIssueTargetTokens(userTask);
  if (targets.length === 0) {
    return 0;
  }

  let attempts = 0;
  for (const item of history) {
    if (classifyActionIntent(item.action) !== "inspect") {
      continue;
    }
    const actionText = `${item.action.thought} ${formatActionInputForPrompt(item.action, 1200)}`;
    if (!targets.some((target) => actionText.includes(target))) {
      continue;
    }
    if (looksLikeNoSearchResults(item.observation)) {
      attempts += 1;
    }
  }
  return attempts;
}

function extractIssueTargetTokens(userTask: string): string[] {
  const tokens = new Set<string>();

  for (const match of userTask.matchAll(/`([^`]{3,120})`/g)) {
    tokens.add(match[1]);
  }
  for (const match of userTask.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:TestCase|Test|Case)\.test_[A-Za-z0-9_]+\b/g)) {
    tokens.add(match[0]);
  }
  for (const match of userTask.matchAll(/\btest_[A-Za-z0-9_]{3,}\b/g)) {
    const after = userTask.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 3);
    if (after.startsWith(".py")) {
      continue;
    }
    tokens.add(match[0]);
  }
  for (const match of userTask.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:TestCase|Test|Case|Spider|Middleware|Fixture|Fixtures)\b/g)) {
    tokens.add(match[0]);
  }

  return [...tokens].filter((token) => !/\s/.test(token));
}

function extractMentionedTestPath(userTask: string): string | undefined {
  const match = /(?:^|\s|`)((?:[A-Za-z]:)?[A-Za-z0-9_.\-\/\\]*test[A-Za-z0-9_.\-\/\\]*\.py)(?:`|\s|$|:)/i.exec(userTask);
  return match?.[1]?.replaceAll("\\", "/");
}

function extractMentionedClassMethod(userTask: string): { className: string; methodName: string } | undefined {
  const match = /\b([A-Z][A-Za-z0-9_]*(?:TestCase|Test|Case))\.(test_[A-Za-z0-9_]+)\b/.exec(userTask);
  if (!match) {
    return undefined;
  }
  return { className: match[1], methodName: match[2] };
}

function looksLikeNoSearchResults(observation: string): boolean {
  return /no matches|no results|0 results|not found|未找到|没有找到|"stdout"\s*:\s*""|"exitCode"\s*:\s*1/i.test(observation);
}

function countRecentWorkflowGuardBlocks(history: AgentHistoryItem[], errorCode?: string): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const observation = history[index].observation;
    if (!/code:\s*[A-Z_]+|errorCode["']?\s*[:=]\s*["']?[A-Z_]+/i.test(observation)) {
      break;
    }
    if (!errorCode || observation.includes(errorCode)) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

function recentVerificationMissingDependency(history: AgentHistoryItem[]): boolean {
  return history
    .slice(-14)
    .some(
      (item) =>
        classifyActionIntent(item.action) === "verify" &&
        /no module named|modulenotfounderror|importerror|pytest['"]?\s*(?:is not recognized|not found)|no module named pytest/i.test(
          item.observation
        )
    );
}

function isReadyForFinal(
  userTask: string,
  workflow: Pick<EditWorkflowState, "plan" | "changedFiles" | "checks">
): boolean {
  if (!hasPassingCheckAfterLatestChangeForCompletion(workflow)) {
    return false;
  }

  const latestCheck = latestCheckAfterLatestChange({
    runId: "readiness",
    plan: workflow.plan,
    changedFiles: workflow.changedFiles,
    checks: workflow.checks
  });
  if (latestCheck && !latestCheck.ok) {
    return false;
  }

  if (taskRequiresPytest(userTask) && !hasPassingCheckAfterLatestChange(workflow, (command) => /\bpytest\b/i.test(command))) {
    return false;
  }

  return true;
}

function normalizeShellCommandForComparison(command: string): string {
  return command.replace(/\s+/g, " ").trim().toLowerCase();
}

function explorationBudgetBeforeFirstEdit(userTask: string, maxSteps: number): number {
  if (taskRequestsEditPlanFirst(userTask)) {
    return 6;
  }

  return Math.min(6, Math.max(4, Math.ceil(maxSteps * 0.12)));
}

function postEditExplorationBudget(): number {
  return 4;
}

function broadExplorationTools(): Set<string> {
  return new Set(["projectScan", "tree", "listDir"]);
}

function explorationToolNames(): Set<string> {
  return new Set(["projectScan", "tree", "listDir", "searchText", "readFile", "readTail", "fileExists", "recall"]);
}

function countConsecutiveExplorationTurns(history: AgentHistoryItem[], explorationTools: Set<string>): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (!isExplorationAction(item.action, explorationTools)) {
      break;
    }
    count += 1;
  }
  return count;
}

function isExplorationAction(action: AgentActionOutput, explorationTools: Set<string>): boolean {
  if (explorationTools.has(action.tool)) {
    return true;
  }

  if (action.tool !== "shell") {
    return false;
  }

  const command = extractShellCommand(action.input);
  return command ? isShellFileReadCommand(command) && !isShellVerificationCommand(command) : false;
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

export function isCodingChangeTask(userTask: string): boolean {
  const chineseKeywords = [
    "\u4fee\u590d",
    "\u4fee\u6539",
    "\u5b9e\u73b0",
    "\u6dfb\u52a0",
    "\u65b0\u589e",
    "\u66f4\u65b0",
    "\u8865\u5145",
    "\u5b8c\u5584",
    "\u89e3\u51b3"
  ];
  if (chineseKeywords.some((keyword) => userTask.includes(keyword))) {
    return true;
  }
  return /\b(fix|repair|implement|add|update|modify|change|patch|resolve)\b/i.test(userTask);
}

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

export type DuplicatePythonTestFunction = {
  path: string;
  name: string;
  lines: number[];
};

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

export function answerLooksIncomplete(answer: string): boolean {
  const patterns = [
    /\u5f85\u5b8c\u6210/,
    /\u672a\u5b8c\u6210/,
    /\u5c1a\u672a/,
    /\u6ca1\u6709\u8fd0\u884c/,
    /\u672a\u8fd0\u884c/,
    /\u672a\u6267\u884c/,
    /\u65e0\u6cd5\u8fd0\u884c/,
    /\u672a\u80fd\u5b8c\u6210/,
    /\u9a8c\u8bc1\u5efa\u8bae/,
    /\u7531\u4e8e.*\u73af\u5883.*\u672a/,
    /\u9700\u8981\u624b\u52a8/,
    /\u624b\u52a8\u5220\u9664/,
    /\u90e8\u5206\u4fee\u6539/,
    /\u5efa\u8bae\u4e0b\u4e00\u6b65/,
    /\u9884\u671f\u901a\u8fc7/,
    /\u9884\u8ba1\u901a\u8fc7/,
    /incomplete/i,
    /not complete/i,
    /not completed/i,
    /unable to run/i,
    /expected to pass/i,
    /should pass/i,
    /still need/i,
    /needs? manual/i,
    /manual follow-up/i,
    /todo/i,
    /remaining task/i,
    /checks?: none run/i
  ];
  return patterns.some((pattern) => pattern.test(answer));
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

export function formatActionInputForPrompt(action: AgentActionOutput, maxChars = 700): string {
  const input = normalizeActionInputForPrompt(action);
  return summarizeText(JSON.stringify(input), maxChars);
}

function normalizeActionInputForPrompt(action: AgentActionOutput): unknown {
  if (action.tool !== "shell" || !action.input || typeof action.input !== "object" || !("command" in action.input)) {
    return action.input;
  }

  const input = action.input as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : "";
  return {
    ...input,
    command:
      command.length > 500
        ? `${command.slice(0, 320)}\n...\n[command compressed: ${command.length} chars]\n...\n${command.slice(-120)}`
        : command
  };
}

export function isShellFileEditCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").toLowerCase();
  const fileWritePatterns = [
    /(?:^|[^0-9])>>?\s*(?!&)[^|\s]+/,
    /\b(set-content|add-content|out-file|new-item)\b/,
    /\bpython(?:3)?\b.*\bopen\s*\([^)]*["'](?:w|a|x|wb|ab|w\+|a\+)["']/,
    /\bpython(?:3)?\b.*\b(write_text|write_bytes|writelines)\s*\(/,
    /\bnode\b.*\b(writefilesync|appendfilesync|writefile|appendfile)\s*\(/,
    /\bperl\b.*\b-i\b/,
    /\bsed\b.*\b-i\b/
  ];
  return fileWritePatterns.some((pattern) => pattern.test(normalized));
}

export function isShellFileReadCommand(command: string): boolean {
  if (isShellFileEditCommand(command)) {
    return false;
  }

  const normalized = command.replace(/\s+/g, " ").toLowerCase();
  const fileReadPatterns = [
    /\b(get-content|gc|type|cat|more|select-string|findstr|grep|rg)\b/,
    /\bgit\s+(status|diff|show|log|grep|ls-files|rev-parse|branch)\b/,
    /\bpython(?:3)?\b.*\bopen\s*\([^)]*\)\s*\.\s*(read|readline|readlines)\s*\(/,
    /\bpython(?:3)?\b.*\b(readlines|read_text)\s*\(/,
    /\bnode\b.*\b(readfilesync|readfile)\s*\(/,
    /\bhead\b/,
    /\btail\b/
  ];
  return fileReadPatterns.some((pattern) => pattern.test(normalized));
}

export function isShellEnvironmentSetupCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").toLowerCase();
  const setupPatterns = [
    /(?:^|[\s&])(?:[^\s&|]*\\)?python(?:3)?(?:\.exe)?\s+-m\s+pip\s+install\b/,
    /\bpip(?:3)?\s+install\b/,
    /\buv\s+(?:pip\s+install|sync|add)\b/,
    /\bpoetry\s+install\b/,
    /\bpdm\s+install\b/,
    /\bconda\s+install\b/
  ];
  return setupPatterns.some((pattern) => pattern.test(normalized));
}

export function isShellVerificationCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").toLowerCase();
  const verificationPatterns = [
    /(?:^|[\s&])(?:[^\s&|]*\\)?python(?:3)?(?:\.exe)?\s+-m\s+pytest\b/,
    /(?:^|[\s&])(?:[^\s&|]*\\)?python(?:3)?(?:\.exe)?\s+-m\s+twisted\.trial\b/,
    /\btwisted\.trial\b/,
    /\bpytest\b/,
    /(?:^|[\s&])(?:[^\s&|]*\\)?python(?:3)?(?:\.exe)?\s+-m\s+(unittest|compileall|mypy|ruff)\b/,
    /\b(ast\.parse|compile\s*\(|py_compile)\b/,
    /\b(npm|pnpm|yarn)\s+(run\s+)?(test|typecheck|lint|check)\b/,
    /\b(tsc|eslint|vitest|jest)\b/,
    /\bnode\b.*\s--check\b/
  ];
  return verificationPatterns.some((pattern) => pattern.test(normalized));
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

export function parseAgentOutput(raw: string): { ok: true; value: AgentOutput } | { ok: false; error: string } {
  const candidates = [stripJsonFence(raw.trim()), extractFirstJsonObject(raw)].filter((item): item is string => Boolean(item));
  let firstError: unknown;

  for (const candidate of candidates) {
    const parsed = parseJsonWithRepair(candidate);
    if (!parsed.ok) {
      firstError ??= parsed.error;
      continue;
    }

    try {
      return { ok: true, value: agentOutputSchema.parse(normalizeAgentOutput(parsed.value)) as AgentActionOutput | AgentFinalOutput };
    } catch (error) {
      firstError ??= error;
    }
  }

  return { ok: false, error: firstError instanceof Error ? firstError.message : String(firstError ?? "Unable to parse agent output") };
}

function normalizeAgentOutput(parsed: unknown): unknown {
  if (!isRecord(parsed) || parsed.type !== "action") {
    return parsed;
  }

  const tool = typeof parsed.tool === "string" ? parsed.tool : typeof parsed.action === "string" ? parsed.action : parsed.tool;
  let input = parsed.input;
  if (!("input" in parsed)) {
    const topLevelInput: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!["type", "thought", "tool", "action"].includes(key)) {
        topLevelInput[key] = value;
      }
    }
    input = topLevelInput;
  }

  return {
    type: parsed.type,
    thought: normalizeActionThought(parsed.thought, String(tool)),
    tool,
    input
  };
}

function normalizeActionThought(thought: unknown, toolName: string): string {
  if (typeof thought !== "string" || !thought.trim() || /[\u3400-\u9fff]/.test(thought)) {
    return `Call ${toolName} for the next workflow step.`;
  }

  return thought;
}

function parseJsonWithRepair(text: string): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    const repairs = [escapeControlCharactersInsideStrings(text)];
    repairs.push(repairJsonScalarTrailingQuotes(repairs[0]));
    const repairedFinal = repairUnterminatedFinalAnswer(repairs[0]);
    if (repairedFinal) {
      repairs.push(repairedFinal);
    }
    for (const repaired of repairs) {
      try {
        return { ok: true, value: JSON.parse(repaired) as unknown };
      } catch {
        // Try the next lightweight repair.
      }
    }
    return { ok: false, error: error as Error };
  }
}

function repairUnterminatedFinalAnswer(text: string): string | undefined {
  const marker = '"answer":"';
  const start = text.indexOf('{"type":"final"');
  const answerStart = text.indexOf(marker);
  if (start !== 0 || answerStart === -1) {
    return undefined;
  }

  const prefixEnd = answerStart + marker.length;
  const answer = text.slice(prefixEnd);
  if (answer.endsWith('"}') || answer.endsWith('"}\n')) {
    return undefined;
  }

  const trimmed = answer.replace(/\s*$/, "");
  const safeAnswer = trimmed.replace(/(?<!\\)"/g, '\\"');
  return `${text.slice(0, prefixEnd)}${safeAnswer}"}`;
}

function repairJsonScalarTrailingQuotes(text: string): string {
  return text
    .replace(/:\s*(-?\d+(?:\.\d+)?)"(\s*[,}])/g, ":$1$2")
    .replace(/:\s*(true|false|null)"(\s*[,}])/gi, ":$1$2");
}

function escapeControlCharactersInsideStrings(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      output += char;
      inString = !inString;
      continue;
    }

    if (inString && char === "\n") {
      output += "\\n";
      continue;
    }

    if (inString && char === "\r") {
      output += "\\r";
      continue;
    }

    if (inString && char === "\t") {
      output += "\\t";
      continue;
    }

    output += char;
  }

  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripJsonFence(text: string): string {
  if (!text.startsWith("```")) {
    return text;
  }
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}
