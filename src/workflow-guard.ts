// Workflow guardrails, stage navigation, and intent classification.
// Extracted from agent.ts (~1000 lines) to keep the main loop focused.

import {
  extractShellCommand,
  isShellCheckCommand,
  requiresEditPlan,
  type EditWorkflowState
} from "./edit-workflow.js";
import { toolFailure } from "./tool-result.js";
import type { AgentActionOutput, AgentHistoryItem, ToolResult } from "./types.js";

// ── re-exported for agent.ts ────────────────────────────────────────

export { extractShellCommand, requiresEditPlan };

// ── tool name sets ──────────────────────────────────────────────────

export function explorationToolNames(): Set<string> {
  return new Set(["projectScan", "tree", "listDir", "searchText", "readFile", "readTail", "fileExists", "recall", "memoryList", "memoryRecall", "readArtifact", "scopedResearch"]);
}

export function broadExplorationTools(): Set<string> {
  return new Set(["projectScan", "tree", "listDir"]);
}

export function countConsecutiveExplorationTurns(history: AgentHistoryItem[], explorationTools: Set<string>): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (!isExplorationAction(history[i].action, explorationTools)) break;
    count += 1;
  }
  return count;
}

function isExplorationAction(action: AgentActionOutput, explorationTools: Set<string>): boolean {
  if (explorationTools.has(action.tool)) return true;
  if (action.tool !== "shell") return false;
  const cmd = extractShellCommand(action.input);
  return cmd ? isShellFileReadCommand(cmd) && !isShellVerificationCommand(cmd) : false;
}

// ── types ───────────────────────────────────────────────────────────

export type WorkflowStage = "analysis" | "plan" | "inspect" | "edit" | "repair-or-verify" | "verify" | "final";
export type ActionIntent = "plan" | "inspect" | "edit" | "verify" | "setup" | "other";
export type WorkflowPolicy = { allowedIntents: ActionIntent[]; reason: string };

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

// ── intent classification ───────────────────────────────────────────

export function classifyActionIntent(action: AgentActionOutput): ActionIntent {
  if (action.tool === "editPlan") return "plan";
  if (requiresEditPlan(action.tool)) return "edit";

  if (action.tool === "shell") {
    const cmd = extractShellCommand(action.input);
    if (!cmd) return "other";
    if (isShellFileEditCommand(cmd)) return "edit";
    if (isShellEnvironmentSetupCommand(cmd)) return "setup";
    if (isShellVerificationCommand(cmd)) return "verify";
    if (isShellFileReadCommand(cmd)) return "inspect";
    return "other";
  }

  if (explorationToolNames().has(action.tool)) return "inspect";
  return "other";
}

// ── stage navigation ────────────────────────────────────────────────

export function workflowPolicyForNavigation(nav: Pick<WorkflowNavigation, "stage" | "reasons">): WorkflowPolicy {
  switch (nav.stage) {
    case "analysis": return { allowedIntents: ["plan", "inspect", "edit", "verify", "setup", "other"], reason: "Non-coding task." };
    case "plan":
      if (nav.reasons.some((r) => /explicitly requested editPlan/i.test(r)))
        return { allowedIntents: ["plan"], reason: "editPlan explicitly requested first." };
      return { allowedIntents: ["plan", "inspect"], reason: "Plan or focused inspection only." };
    case "inspect": return { allowedIntents: ["inspect", "edit", "verify"], reason: "Inspection window open." };
    case "edit": return { allowedIntents: ["edit", "verify", "setup"], reason: "Exploration budget spent; edit or verify." };
    case "repair-or-verify": return { allowedIntents: ["inspect", "edit", "verify", "setup"], reason: "Repair or verify." };
    case "verify": return { allowedIntents: ["edit", "verify", "setup"], reason: "Verification phase." };
    case "final": return { allowedIntents: [], reason: "Finished; output final." };
  }
}

export function formatAllowedIntentsForPrompt(intents: ActionIntent[]): string {
  if (intents.length === 0) return "none; output final instead of calling tools";
  const d: Record<ActionIntent, string> = {
    plan: "plan=editPlan", inspect: "inspect=focused read/search/git status only",
    edit: "edit=replaceLines/insertAtLine/replaceText/insertText/applyPatch",
    verify: "verify=pytest/typecheck/py_compile/test command",
    setup: "setup=install/sync only after missing dependency failure",
    other: "other=non-file/non-workflow action"
  };
  return intents.map((i) => d[i]).join("; ");
}

export function workflowProfileForTask(userTask: string, maxSteps: number, options: { taskSpecificEnabled?: boolean } = {}): WorkflowProfile {
  const taskSpecificEnabled = options.taskSpecificEnabled !== false;
  if (isIssueFixTask(userTask)) {
    return {
      kind: "issue-fix",
      explorationBudget: taskSpecificEnabled && taskRequestsEditPlanFirst(userTask) ? 7 : 5,
      postEditExplorationBudget: 2,
      targetMissLimit: 2
    };
  }
  return {
    kind: "generic",
    explorationBudget: taskSpecificEnabled && taskRequestsEditPlanFirst(userTask) ? 6 : Math.min(6, Math.max(4, Math.ceil(maxSteps * 0.12))),
    postEditExplorationBudget: 4,
    targetMissLimit: 3
  };
}

export function issueFixPromptHints(userTask: string): string[] {
  if (!isIssueFixTask(userTask)) return [];
  const hints: string[] = [];
  const targets = extractIssueTargetTokens(userTask);
  const testPath = extractMentionedTestPath(userTask);
  const classMethod = extractMentionedClassMethod(userTask);
  const testFunction = targets.find((t) => /^test_[A-Za-z0-9_]+$/.test(t));
  if (targets.length > 0) hints.push(`Exact target symbols: ${targets.join(", ")}`);
  if (testPath && classMethod) hints.push(`Targeted pytest candidate: python -m pytest ${testPath}::${classMethod.className}::${classMethod.methodName} -q`);
  else if (testPath && testFunction) hints.push(`Targeted pytest candidate: python -m pytest ${testPath}::${testFunction} -q`);
  else if (classMethod) hints.push(`Targeted pytest candidate: python -m pytest -k "${classMethod.className} and ${classMethod.methodName}" -q`);
  else if (testFunction) hints.push(`Targeted pytest candidate: python -m pytest -k "${testFunction}" -q`);
  return hints;
}

export function navigateWorkflow(
  userTask: string,
  workflow: Pick<EditWorkflowState, "plan" | "changedFiles" | "checks">,
  history: AgentHistoryItem[] = [],
  step = 1,
  maxSteps = 10,
  options: { taskSpecificEnabled?: boolean } = {}
): WorkflowNavigation {
  const taskSpecificEnabled = options.taskSpecificEnabled !== false;
  const profile = workflowProfileForTask(userTask, maxSteps, { taskSpecificEnabled });
  const eb = profile.explorationBudget;
  const aeb = profile.postEditExplorationBudget;
  const repeated = countConsecutiveExplorationTurns(history, explorationToolNames());
  const reasons: string[] = [];

  if (!isCodingChangeTask(userTask)) {
    return { stage: "analysis", recommendedAction: "Gather evidence, then answer.", blockedActions: [], reasons: ["Non-coding task."], explorationBudget: eb, postEditExplorationBudget: aeb, repeatedExploration: repeated };
  }

  if (!workflow.plan) {
    if (taskSpecificEnabled && taskRequestsEditPlanFirst(userTask)) {
      reasons.push("editPlan explicitly requested first.");
      return { stage: "plan", recommendedAction: "Call editPlan now.", blockedActions: ["readFile", "searchText", "projectScan", "tree", "listDir", "shell", "final"], reasons, explorationBudget: eb, postEditExplorationBudget: aeb, repeatedExploration: repeated };
    }
    reasons.push("No edit plan recorded.");
    return { stage: "plan", recommendedAction: "Focused inspection then editPlan.", blockedActions: ["final"], reasons, explorationBudget: eb, postEditExplorationBudget: aeb, repeatedExploration: repeated };
  }

  if (workflow.changedFiles.length === 0) {
    if (repeated >= eb || step > eb) {
      reasons.push("Pre-edit exploration budget spent.");
      return { stage: "edit", recommendedAction: "Make the first real planned edit now.", blockedActions: ["projectScan", "tree", "listDir", "readFile", "searchText", "readTail", "fileExists", "recall", "final"], reasons, explorationBudget: eb, postEditExplorationBudget: aeb, repeatedExploration: repeated };
    }
    reasons.push("Plan exists, no files changed.");
    return { stage: "inspect", recommendedAction: `Focused inspection; edit before ${eb} consecutive turns.`, blockedActions: ["projectScan", "tree", "listDir", "final"], reasons, explorationBudget: eb, postEditExplorationBudget: aeb, repeatedExploration: repeated };
  }

  if (workflow.checks.length === 0) {
    if (repeated >= aeb) {
      reasons.push("Post-edit inspection repeating without verification.");
      return { stage: "verify", recommendedAction: "Run relevant check or repair edit.", blockedActions: ["projectScan", "tree", "listDir", "readFile", "searchText", "readTail", "fileExists", "recall"], reasons, explorationBudget: eb, postEditExplorationBudget: aeb, repeatedExploration: repeated };
    }
    reasons.push("Files changed, no verification.");
    return { stage: "repair-or-verify", recommendedAction: "Run check now; inspect only if needed.", blockedActions: ["projectScan", "tree", "listDir"], reasons, explorationBudget: eb, postEditExplorationBudget: aeb, repeatedExploration: repeated };
  }

  const lc = latestCheckAfterLatestChange(workflow);
  if (lc && !lc.ok) {
    reasons.push("Latest verification failed.");
    return { stage: "repair-or-verify", recommendedAction: "Repair the failure, rerun check.", blockedActions: ["projectScan", "tree", "listDir", "final"], reasons, explorationBudget: eb, postEditExplorationBudget: aeb, repeatedExploration: repeated };
  }

  if (isReadyForFinal(userTask, workflow)) {
    reasons.push("Verification passed after latest edit.");
    return { stage: "final", recommendedAction: "Provide final answer.", blockedActions: ["projectScan", "tree", "listDir", "readFile", "searchText", "shell"], reasons, explorationBudget: eb, postEditExplorationBudget: aeb, repeatedExploration: repeated };
  }

  reasons.push("Checks exist, none passed after latest edit.");
  return { stage: "verify", recommendedAction: "Run relevant check before final.", blockedActions: ["projectScan", "tree", "listDir", "final"], reasons, explorationBudget: eb, postEditExplorationBudget: aeb, repeatedExploration: repeated };
}

// ── the main guardrail function ─────────────────────────────────────

export function maybeBlockByStageBudget(
  action: AgentActionOutput,
  userTask: string,
  step: number,
  maxSteps: number,
  workflow: EditWorkflowState,
  history: AgentHistoryItem[] = [],
  policies: { efficiencyEnabled?: boolean; taskSpecificEnabled?: boolean } = {}
): ToolResult | undefined {
  const efficiencyEnabled = policies.efficiencyEnabled !== false;
  const taskSpecificEnabled = policies.taskSpecificEnabled !== false;
  if (!isCodingChangeTask(userTask)) {
    if (!efficiencyEnabled) return undefined;
    const tools = new Set([...explorationToolNames(), "shell"]);
    const isMcp = action.tool.startsWith("mcp_");
    const consecutive = countConsecutiveExplorationTurns(history, tools);
    const total = consecutive + (isMcp || explorationToolNames().has(action.tool) ? 1 : 0);
    const limit = Math.max(4, Math.min(10, Math.ceil(maxSteps * 0.4)));
    const isExpl = explorationToolNames().has(action.tool) || isMcp || action.tool === "shell";

    if (total >= limit && isExpl) {
      return toolFailure({
        content: `You've gathered information for ${total} turns (limit: ${limit}). Stop exploring; provide a final answer.`,
        errorCode: "ANALYSIS_EXPLORATION_LIMIT", retryable: true,
        metadata: { step, maxSteps, exploreLimit: limit, toolName: action.tool }
      });
    }
    if (total >= limit - 1 && isExpl) {
      return toolFailure({
        content: `${total} consecutive exploration turns. One more before you must finalize.`,
        errorCode: "ANALYSIS_EXPLORATION_WARNING", retryable: true,
        metadata: { step, maxSteps, exploreLimit: limit, toolName: action.tool }
      });
    }
    return undefined;
  }

  const navigation = navigateWorkflow(userTask, workflow, history, step, maxSteps, { taskSpecificEnabled });
  const actionIntent = classifyActionIntent(action);
  const editFailureRecovery = detectEditFailureRecoveryInspection(action, history);

  if (taskSpecificEnabled && taskRequestsEditPlanFirst(userTask) && !workflow.plan && action.tool !== "editPlan") {
    return toolFailure({
      content: "editPlan must be called first. Call editPlan now before any inspection or edits.",
      errorCode: "EDIT_PLAN_REQUIRED_FIRST", retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  if (workflow.plan && action.tool === "editPlan") {
    return toolFailure({
      content: "Edit plan already exists. Continue with edit, check, or final — do not recreate the plan.",
      errorCode: "EDIT_PLAN_ALREADY_EXISTS", retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const fakeEdit = detectFakeProgressEdit(action);
  if (workflow.plan && workflow.changedFiles.length === 0 && fakeEdit) {
    return toolFailure({
      content: `${fakeEdit} Do not make dummy edits. Make the real planned edit now.`,
      errorCode: "FAKE_PROGRESS_EDIT_BLOCKED", retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const assertionWeakening = detectTestAssertionWeakening(action, userTask);
  if (assertionWeakening) {
    return toolFailure({
      content: assertionWeakening,
      errorCode: "TEST_ASSERTION_WEAKENING_BLOCKED", retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const repeatedFailedEdit = detectRepeatedFailedEditWithoutContext(action, history);
  if (repeatedFailedEdit) {
    return toolFailure({
      content: repeatedFailedEdit,
      errorCode: "EDIT_CONTEXT_REQUIRED", retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const repeatedReplace = detectRepeatedReplaceTextFailure(action, history);
  if (repeatedReplace) {
    return toolFailure({
      content: repeatedReplace,
      errorCode: "REPLACE_TEXT_REPEATED_FAILURE", retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const unverifiedLine = detectUnverifiedLineEdit(action, history);
  if (unverifiedLine) {
    return toolFailure({
      content: unverifiedLine,
      errorCode: "UNVERIFIED_LINE_EDIT_BLOCKED", retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const shellCmd = action.tool === "shell" ? extractShellCommand(action.input) : undefined;
  if (shellCmd && isShellFileEditCommand(shellCmd)) {
    return toolFailure({
      content: "Shell commands that write workspace files are blocked. Use replaceLines, insertAtLine, replaceText, insertText, applyPatch, or writeFile instead.",
      errorCode: "SHELL_FILE_EDIT_BLOCKED", retryable: true,
      metadata: { toolName: action.tool }
    });
  }

  if (workflow.changedFiles.length > 0 && isReadyForFinal(userTask, workflow)) {
    return toolFailure({
      content: "Verification passed after latest edit. Provide final answer — do not make cosmetic edits.",
      errorCode: "FINAL_READY_EDIT_BLOCKED", retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  const latestCheck = latestCheckAfterLatestChange(workflow);
  if (shellCmd && latestCheck && !latestCheck.ok && normalizeCmd(shellCmd) === normalizeCmd(latestCheck.command)) {
    return toolFailure({
      content: "This verification command already failed after the latest edit. Make a repair edit first, then rerun.",
      errorCode: "REDUNDANT_FAILED_CHECK_BLOCKED", retryable: true,
      metadata: { step, toolName: action.tool, command: shellCmd }
    });
  }

  const riskyImport = detectRiskyPythonTopImport(action);
  if (riskyImport) {
    return toolFailure({
      content: `${riskyImport} Read the file top first, insert after module docstring and __future__ imports.`,
      errorCode: "PYTHON_TOP_IMPORT_BLOCKED", retryable: true,
      metadata: { step, toolName: action.tool }
    });
  }

  if (actionIntent === "setup" && !recentVerificationMissingDependency(history)) {
    return toolFailure({
      content: "Environment setup blocked. Run the relevant check first to confirm a missing dependency.",
      errorCode: "ENV_SETUP_NOT_JUSTIFIED", retryable: true,
      metadata: { step, maxSteps, toolName: action.tool }
    });
  }

  const eb = navigation.explorationBudget;
  const editBudget = Math.max(eb + 2, Math.ceil(maxSteps * 0.65));
  const broadTools = broadExplorationTools();
  const isExploration = actionIntent === "inspect";
  const isTargetedLookup = isTargetedConventionLookup(action, userTask);
  const isBroadRead = action.tool === "readFile" && (!action.input || typeof action.input !== "object" ||
    (!("startLine" in action.input) && !("lineCount" in action.input) && !("offset" in action.input) && !("limit" in action.input)));

  if (efficiencyEnabled && workflow.plan && workflow.changedFiles.length === 0 && step > eb && (broadTools.has(action.tool) || isBroadRead) && !editFailureRecovery) {
    return toolFailure({
      content: "Exploration budget exceeded. Use focused search/ranged read, or make the planned edit now.",
      errorCode: "EXPLORATION_BUDGET_EXCEEDED", retryable: true,
      metadata: { step, maxSteps, explorationBudget: eb, toolName: action.tool }
    });
  }

  const repeatedExpl = countConsecutiveExplorationTurns(history, explorationToolNames());
  if (taskSpecificEnabled && workflow.plan && workflow.changedFiles.length === 0 && isIssueFixTask(userTask) &&
    countFailedTargetLocationAttempts(history, userTask) >= (workflowProfileForTask(userTask, maxSteps, { taskSpecificEnabled }).targetMissLimit) &&
    isExploration && !editFailureRecovery && !isTargetedLookup) {
    return toolFailure({
      content: "Issue target not located after repeated exact searches. Report missing symbols and recommend the user verify the checkout.",
      errorCode: "TARGET_NOT_LOCATED_PRECHECK_FAILED", retryable: true,
      metadata: { step, maxSteps, toolName: action.tool }
    });
  }

  if (efficiencyEnabled && workflow.plan && workflow.changedFiles.length === 0 && repeatedExpl >= eb && isExploration && !editFailureRecovery && !isTargetedLookup) {
    return toolFailure({
      content: "Repeated exploration blocked before any edits. Make the real planned edit now using line numbers/anchors from history.",
      errorCode: "REPEATED_EXPLORATION_BLOCKED", retryable: true,
      metadata: { step, maxSteps, explorationBudget: eb, repeatedExploration: repeatedExpl, toolName: action.tool }
    });
  }

  if (efficiencyEnabled && workflow.plan && workflow.changedFiles.length === 0 && step > eb + 2 && isExploration && !editFailureRecovery && !isTargetedLookup) {
    return toolFailure({
      content: "Pre-edit inspection window closed. Make the first real edit now.",
      errorCode: "PRE_EDIT_EXPLORATION_WINDOW_CLOSED", retryable: true,
      metadata: { step, maxSteps, explorationBudget: eb, toolName: action.tool }
    });
  }

  if (efficiencyEnabled && workflow.changedFiles.length > 0 && workflow.checks.length === 0 && repeatedExpl >= navigation.postEditExplorationBudget && isExploration) {
    return toolFailure({
      content: `${navigation.recommendedAction} Do not keep rereading the same regions.`,
      errorCode: "POST_EDIT_EXPLORATION_BLOCKED", retryable: true,
      metadata: { step, maxSteps, repeatedExploration: repeatedExpl, toolName: action.tool }
    });
  }

  if (efficiencyEnabled && workflow.changedFiles.length > 0 && workflow.checks.length === 0 && step >= editBudget && broadTools.has(action.tool)) {
    return toolFailure({
      content: "Verification phase after edits. Run a check, repair, or finish.",
      errorCode: "VERIFICATION_PHASE_REQUIRED", retryable: true,
      metadata: { step, maxSteps, editBudget, toolName: action.tool }
    });
  }

  const policy = workflowPolicyForNavigation(navigation);
  if (efficiencyEnabled && !policy.allowedIntents.includes(actionIntent) && !isTargetedLookup && !editFailureRecovery) {
    const recentBlocks = countRecentWorkflowGuardBlocks(history, "STAGE_INTENT_BLOCKED");
    return toolFailure({
      content:
        `${policy.reason} Current workflow stage is "${navigation.stage}". Recommended next action: ${navigation.recommendedAction}\n` +
        `Allowed action intents now: ${formatAllowedIntentsForPrompt(policy.allowedIntents)}.\n` +
        (recentBlocks > 0
          ? `This is workflow policy violation #${recentBlocks + 1} in the recent context. Stop trying adjacent tools; choose only an allowed intent next turn.`
          : "Choose only an allowed intent next turn."),
      errorCode: "STAGE_INTENT_BLOCKED", retryable: true,
      metadata: { step, maxSteps, stage: navigation.stage, actionIntent, toolName: action.tool, recentPolicyBlocks: recentBlocks }
    });
  }

  return undefined;
}

// ── detection functions ─────────────────────────────────────────────

function normalizeCmd(cmd: string): string { return cmd.replace(/\s+/g, " ").trim().toLowerCase(); }

export function isCodingChangeTask(userTask: string): boolean {
  const cjk = ["修复", "修改", "实现", "添加", "新增", "更新", "补充", "完善", "解决"];
  if (cjk.some((k) => userTask.includes(k))) return true;
  return /\b(fix|repair|implement|add|update|modify|change|patch|resolve)\b/i.test(userTask);
}

export function taskRequestsEditPlanFirst(userTask: string): boolean {
  return /\beditPlan\b/.test(userTask);
}

function detectFakeProgressEdit(action: AgentActionOutput): string | undefined {
  if (!action.input || typeof action.input !== "object") return undefined;
  const input = action.input as Record<string, unknown>;
  if (action.tool === "replaceText" && typeof input.search === "string" && input.search === input.replacement)
    return "replaceText would not change the file.";
  const content = typeof input.content === "string" ? input.content : "";
  if (!["appendFile", "appendToFile", "insertText", "insertAtLine", "replaceLines", "writeFile"].includes(action.tool)) return undefined;
  if (/\b(dummy|temporary|temp|unblock|bypass|exploration|harmless comment)\b/.test(content.toLowerCase()))
    return "Edit appears to be temporary or to unblock exploration.";
  return undefined;
}

function detectTestAssertionWeakening(action: AgentActionOutput, userTask: string): string | undefined {
  if (!isIssueFixTask(userTask) || !action.input || typeof action.input !== "object") return undefined;
  const input = action.input as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path.replaceAll("\\", "/") : "";
  if (!/(^|\/)tests?\//.test(path) && !/(^|\/)test_[^/]+\.py$/.test(path) && !/(^|\/)[^/]+_test\.py$/.test(path)) return undefined;
  const search = typeof input.search === "string" ? input.search : "";
  const replacement = typeof input.replacement === "string" ? input.replacement : typeof input.content === "string" ? input.content : "";
  const removesAssert = /\b(assert|AssertionError|pytest\.raises|self\.assert[A-Z]\w*)\b/.test(search);
  const keepsAssert = /\b(assert|AssertionError|pytest\.raises|self\.assert[A-Z]\w*)\b/.test(replacement);
  const commentOnly = replacement.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).every((l) => l.startsWith("#"));
  if (removesAssert && (!keepsAssert || commentOnly))
    return "This edit weakens or removes a test assertion. Fix the behavior, don't delete the oracle.";
  return undefined;
}

function detectRepeatedFailedEditWithoutContext(action: AgentActionOutput, history: AgentHistoryItem[]): string | undefined {
  const path = extractEditPath(action);
  if (!path) return undefined;
  const recent = history.slice(-10);
  const count = recent.filter((item) => {
    if (extractEditPath(item.action) !== path) return false;
    return /\b(TEXT_NOT_FOUND|UNVERIFIED_LINE_EDIT_BLOCKED|PYTHON_TOP_IMPORT_BLOCKED|FAKE_PROGRESS_EDIT_BLOCKED)\b/.test(item.observation);
  }).length;
  if (count < 2 || recent.some((item) => {
    if (item.action.tool !== "readFile" || !item.action.input || typeof item.action.input !== "object") return false;
    if (/\[tool_error\]|code:\s*[A-Z_]+/i.test(item.observation)) return false;
    const rp = (item.action.input as Record<string, unknown>).path;
    return typeof rp === "string" && normalizeProjectPath(rp) === path;
  })) return undefined;
  return `Recent edits on ${path} failed without current context. Read a focused range first, then make one anchored edit.`;
}

function detectRepeatedReplaceTextFailure(action: AgentActionOutput, history: AgentHistoryItem[]): string | undefined {
  if (action.tool !== "replaceText") return undefined;
  const path = extractEditPath(action);
  if (!path) return undefined;
  let count = 0;
  for (const item of history.slice(-12)) {
    if (item.action.tool === "replaceText" && extractEditPath(item.action) === path && /\bTEXT_NOT_FOUND\b/.test(item.observation)) count += 1;
  }
  if (count < 3) return undefined;
  return `replaceText on ${path} failed ${count} times with TEXT_NOT_FOUND. Read a focused range and use replaceLines instead.`;
}

function detectEditFailureRecoveryInspection(action: AgentActionOutput, history: AgentHistoryItem[]): boolean {
  if (!["readFile", "searchText"].includes(action.tool) || !action.input || typeof action.input !== "object") return false;
  const failedPath = latestFailedEditPath(history);
  if (!failedPath) return false;
  const input = action.input as Record<string, unknown>;
  if (action.tool === "readFile") {
    const p = typeof input.path === "string" ? normalizeProjectPath(input.path) : "";
    const hasRange = "startLine" in input || "lineCount" in input || "offset" in input || "limit" in input;
    return p === failedPath && hasRange;
  }
  const root = typeof input.root === "string" ? normalizeProjectPath(input.root) : "";
  const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
  return pattern.length >= 3 && (root === failedPath || root === "." || root === "");
}

function latestFailedEditPath(history: AgentHistoryItem[]): string | undefined {
  for (const item of [...history].reverse().slice(0, 8)) {
    const p = extractEditPath(item.action);
    if (p && /\b(TEXT_NOT_FOUND|UNVERIFIED_LINE_EDIT_BLOCKED|EDIT_CONTEXT_REQUIRED)\b/.test(item.observation)) return p;
  }
  return undefined;
}

function extractEditPath(action: AgentActionOutput): string | undefined {
  if (!["writeFile", "appendFile", "appendToFile", "replaceText", "insertText", "replaceLines", "insertAtLine"].includes(action.tool) ||
    !action.input || typeof action.input !== "object") return undefined;
  const p = (action.input as Record<string, unknown>).path;
  return typeof p === "string" ? normalizeProjectPath(p) : undefined;
}

function detectUnverifiedLineEdit(action: AgentActionOutput, history: AgentHistoryItem[]): string | undefined {
  if (!["replaceLines", "insertAtLine"].includes(action.tool) || !action.input || typeof action.input !== "object") return undefined;
  const input = action.input as Record<string, unknown>;
  const path = typeof input.path === "string" ? normalizeProjectPath(input.path) : "";
  const lv = action.tool === "replaceLines" ? input.startLine : input.line;
  const line = typeof lv === "number" ? lv : Number(lv);
  if (!path || !Number.isFinite(line) || line < 120) return undefined;
  if (history.slice(-12).some((item) => {
    if (item.action.tool !== "readFile" || !item.action.input || typeof item.action.input !== "object") return false;
    if (/\[tool_error\]|code:\s*[A-Z_]+/i.test(item.observation)) return false;
    const inp = item.action.input as Record<string, unknown>;
    const rp = typeof inp.path === "string" ? normalizeProjectPath(inp.path) : "";
    if (rp !== path) return false;
    const sv = inp.startLine ?? inp.offset; const cv = inp.lineCount ?? inp.limit;
    const sl = typeof sv === "number" ? sv : Number(sv);
    const lc = typeof cv === "number" ? cv : Number(cv);
    return Number.isFinite(sl) && Number.isFinite(lc) && lc > 0 && line >= sl - 2 && line <= sl + lc - 1 + 2;
  })) return undefined;
  return `High line edit ${path}:${line} without recent line context. Read a focused range first or use a text anchor.`;
}

function detectRiskyPythonTopImport(action: AgentActionOutput): string | undefined {
  if (action.tool !== "insertAtLine" || !action.input || typeof action.input !== "object") return undefined;
  const input = action.input as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path : "";
  const line = typeof input.line === "number" ? input.line : Number(input.line);
  const content = typeof input.content === "string" ? input.content.trimStart() : "";
  if (!path.endsWith(".py") || line !== 1 || !/^import\s+|^from\s+(?!__future__\b)/.test(content)) return undefined;
  return "Normal import at Python file line 1 may break module docstring or __future__ imports. Check the file top first.";
}

function isTargetedConventionLookup(action: AgentActionOutput, userTask: string): boolean {
  if (!/\b(warn|warning|log|logging|error|diagnostic)\b/i.test(userTask)) return false;
  if (action.tool !== "searchText" || !action.input || typeof action.input !== "object") return false;
  const input = action.input as Record<string, unknown>;
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const root = typeof input.root === "string" ? input.root.replaceAll("\\", "/") : "";
  return /\b(warn|warning|console\.warning|logger|logging|def warning|def warn)\b/i.test(pattern) &&
    root.length > 0 && root !== "." && !root.endsWith("/") && !/\b(node_modules|\.git|dist|build|site-packages)\b/.test(root);
}

export function isIssueFixTask(userTask: string): boolean {
  return /\bissue\s*#?\d+\b|#[0-9]{2,}\b/i.test(userTask);
}

function countFailedTargetLocationAttempts(history: AgentHistoryItem[], userTask: string): number {
  const targets = extractIssueTargetTokens(userTask);
  if (targets.length === 0) return 0;
  let attempts = 0;
  for (const item of history) {
    if (classifyActionIntent(item.action) !== "inspect") continue;
    const text = `${item.action.thought} ${JSON.stringify(item.action.input).slice(0, 400)}`;
    if (targets.some((t) => text.includes(t)) && looksLikeNoSearchResults(item.observation)) attempts += 1;
  }
  return attempts;
}

function extractIssueTargetTokens(userTask: string): string[] {
  const tokens = new Set<string>();
  for (const m of userTask.matchAll(/`([^`]{3,120})`/g)) tokens.add(m[1]);
  for (const m of userTask.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:TestCase|Test|Case)\.test_[A-Za-z0-9_]+\b/g)) tokens.add(m[0]);
  for (const m of userTask.matchAll(/\btest_[A-Za-z0-9_]{3,}\b/g)) {
    const after = userTask.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 3);
    if (!after.startsWith(".py")) tokens.add(m[0]);
  }
  for (const m of userTask.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:TestCase|Test|Case|Spider|Middleware|Fixture|Fixtures)\b/g)) tokens.add(m[0]);
  return [...tokens].filter((t) => !/\s/.test(t));
}

function extractMentionedTestPath(userTask: string): string | undefined {
  const m = /(?:^|\s|`)((?:[A-Za-z]:)?[A-Za-z0-9_.\-\/\\]*test[A-Za-z0-9_.\-\/\\]*\.py)(?:`|\s|$|:)/i.exec(userTask);
  return m?.[1]?.replaceAll("\\", "/");
}

function extractMentionedClassMethod(userTask: string): { className: string; methodName: string } | undefined {
  const m = /\b([A-Z][A-Za-z0-9_]*(?:TestCase|Test|Case))\.(test_[A-Za-z0-9_]+)\b/.exec(userTask);
  return m ? { className: m[1], methodName: m[2] } : undefined;
}

function looksLikeNoSearchResults(observation: string): boolean {
  return /no matches|no results|0 results|not found|"stdout"\s*:\s*""|"exitCode"\s*:\s*1/i.test(observation);
}

export function countRecentWorkflowGuardBlocks(history: AgentHistoryItem[], errorCode?: string): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const obs = history[i].observation;
    if (!/code:\s*[A-Z_]+|errorCode["']?\s*[:=]\s*["']?[A-Z_]+/i.test(obs)) break;
    if (!errorCode || obs.includes(errorCode)) { count += 1; continue; }
    break;
  }
  return count;
}

function recentVerificationMissingDependency(history: AgentHistoryItem[]): boolean {
  return history.slice(-14).some((item) =>
    classifyActionIntent(item.action) === "verify" &&
    /no module named|modulenotfounderror|importerror|pytest.*not found|no module named pytest/i.test(item.observation)
  );
}

export function isReadyForFinal(userTask: string, workflow: Pick<EditWorkflowState, "plan" | "changedFiles" | "checks">): boolean {
  if (!hasPassingCheckAfterLatestChange(workflow)) return false;
  const lc = latestCheckAfterLatestChange(workflow);
  if (lc && !lc.ok) return false;
  if (taskRequiresPytest(userTask) && !hasPassingCheckAfterLatestChange(workflow, (c) => /\bpytest\b/i.test(c))) return false;
  return true;
}

function hasPassingCheckAfterLatestChange(
  state: Pick<EditWorkflowState, "changedFiles" | "checks">,
  pred: (cmd: string) => boolean = () => true
): boolean {
  if (state.changedFiles.length === 0 || state.checks.length === 0) return false;
  const changeTimes = state.changedFiles.map((item) => Date.parse(item.timestamp)).filter(Number.isFinite);
  const eligible = state.checks.filter((c) => isVerCheck(c.command) && c.ok && pred(c.command));
  if (changeTimes.length === 0) return eligible.length > 0;
  const latest = Math.max(...changeTimes);
  return eligible.some((c) => Date.parse(c.timestamp) >= latest);
}

function latestCheckAfterLatestChange(state: Pick<EditWorkflowState, "changedFiles" | "checks">): EditWorkflowState["checks"][number] | undefined {
  if (state.changedFiles.length === 0) return undefined;
  const changeTimes = state.changedFiles.map((item) => Date.parse(item.timestamp)).filter(Number.isFinite);
  if (changeTimes.length === 0) return state.checks[state.checks.length - 1];
  const latest = Math.max(...changeTimes);
  return state.checks.filter((c) => Date.parse(c.timestamp) >= latest).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
}

function isVerCheck(command: string): boolean {
  return isShellVerificationCommand(command) && !isShellEnvironmentSetupCommand(command);
}

function taskRequiresPytest(userTask: string): boolean {
  return /\bpytest\b/i.test(userTask);
}

function normalizeProjectPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

// ── final assessment ────────────────────────────────────────────────

export type DuplicatePythonTestFunction = { path: string; name: string; lines: number[] };

export function assessFinalCompletion(
  userTask: string,
  answer: string,
  state: Pick<EditWorkflowState, "plan" | "changedFiles" | "checks">,
  options: { workspaceChangedFiles?: string[]; duplicateTestFunctions?: DuplicatePythonTestFunction[] } = {}
): { ok: true } | { ok: false; message: string; reasons: string[] } {
  if (!isCodingChangeTask(userTask)) return { ok: true };
  const reasons: string[] = [];
  if (state.changedFiles.length === 0) reasons.push("No changed files recorded.");
  else if (state.checks.length === 0) reasons.push("No verification checks run after edits.");
  else if (!hasPassingCheckAfterLatestChange(state)) reasons.push("No verification checks passed after edits.");
  if (taskRequiresPytest(userTask) && state.changedFiles.length > 0 && !hasPassingCheckAfterLatestChange(state, (c) => /\bpytest\b/i.test(c)))
    reasons.push("No pytest check passed after latest edits.");
  if (answerLooksIncomplete(answer)) reasons.push("Final answer reports incomplete work.");
  if (options.duplicateTestFunctions?.length)
    reasons.push(`Duplicate test functions: ${options.duplicateTestFunctions.map((d) => `${d.path}:${d.name}`).join("; ")}`);
  return reasons.length === 0 ? { ok: true } : { ok: false, message: `Task not complete.\n${reasons.map((r) => `- ${r}`).join("\n")}`, reasons };
}

export function answerLooksIncomplete(answer: string): boolean {
  const patterns = [
    /待完成/, /未完成/, /尚未/, /没有运行/, /未运行/, /未执行/, /无法运行/, /未能完成/, /验证建议/,
    /由于.*环境.*未/, /需要手动/, /手动删除/, /部分修改/, /建议下一步/, /预期通过/, /预计通过/,
    /incomplete/i, /not complete/i, /not completed/i, /unable to run/i, /expected to pass/i,
    /should pass/i, /still need/i, /needs? manual/i, /manual follow-up/i, /todo/i, /remaining task/i,
    /checks?: none run/i
  ];
  return patterns.some((p) => p.test(answer));
}

// ── re-export shell classifiers (used by agent.ts and tests) ────────

import {
  isShellFileEditCommand,
  isShellFileReadCommand,
  isShellEnvironmentSetupCommand,
  isShellVerificationCommand,
} from "./shell-classify.js";

export { isShellFileEditCommand, isShellFileReadCommand, isShellEnvironmentSetupCommand, isShellVerificationCommand };
