import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceSnapshot, TaskAssessment, TaskVerdict } from "./verification.js";
import type { PiRunWorkflowSnapshot } from "./pi-workflow.js";

export const taskDomainEntryType = "actlume.task-state.v1";

export type TaskDomainEventKind =
  | "task_opened"
  | "task_prompt"
  | "task_branch"
  | "run_started"
  | "workflow_snapshot"
  | "tool_started"
  | "tool_finished"
  | "verification"
  | "completion_claim"
  | "run_finished"
  | "run_interrupted"
  | "task_verdict"
  | "task_closed";

export type TaskDomainEvent = {
  schemaVersion: 1;
  eventId: string;
  kind: TaskDomainEventKind;
  workspaceId: string;
  sessionId: string;
  taskId: string;
  branchId: string;
  at: string;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  payload: Record<string, unknown>;
};

export type TaskPromptReference = {
  entryId?: string;
  preview: string;
  sha256: string;
};

export type PersistedTaskState = {
  schemaVersion: 1;
  taskId: string;
  workspaceId: string;
  sessionId: string;
  branchId: string;
  status: "active" | "closed";
  openedAt: string;
  startedFromEntryId?: string;
  goal: string;
  goalHash: string;
  goalTruncated: boolean;
  baseline?: WorkspaceSnapshot;
  requirementRevision: number;
  recentPrompts: TaskPromptReference[];
  latestRunId?: string;
  latestRunStatus?: "running" | "completed" | "failed" | "cancelled" | "interrupted" | "budget_exhausted" | "unknown";
  workflow?: PiRunWorkflowSnapshot;
  outstandingTools: Array<{ toolCallId: string; toolName: string; runId?: string }>;
  verificationIds: string[];
  lastAssessment?: TaskAssessment;
  taskVerdict: TaskVerdict;
  taskVerdictSource?: "human" | "oracle";
  taskVerdictReason?: string;
  verdictRequirementRevision?: number;
  completionClaim?: { status: "claimed_complete" | "not_claimed" | "unknown"; preview: string; runId?: string };
  recoveryWarning?: string;
};

export type TaskProjection = {
  active?: PersistedTaskState;
  latest?: PersistedTaskState;
  issues: string[];
};

export type PiEntryLike = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
  id?: unknown;
};

const eventKinds = new Set<TaskDomainEventKind>([
  "task_opened", "task_prompt", "task_branch", "run_started", "workflow_snapshot",
  "tool_started", "tool_finished", "verification", "completion_claim", "run_finished", "run_interrupted", "task_verdict", "task_closed"
]);

export function workspaceIdentity(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  const canonical = process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export function branchIdentity(workspaceId: string, sessionId: string, leafId: string | null | undefined): string {
  return createHash("sha256").update(`${workspaceId}\0${sessionId}\0${leafId ?? "root"}`).digest("hex").slice(0, 24);
}

export function createTaskDomainEvent(input: {
  kind: TaskDomainEventKind;
  workspaceId: string;
  sessionId: string;
  taskId: string;
  branchId: string;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  payload?: Record<string, unknown>;
}): TaskDomainEvent {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    kind: input.kind,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    branchId: input.branchId,
    at: new Date().toISOString(),
    runId: input.runId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    payload: input.payload ?? {}
  };
}

export function makeTaskOpenedEvent(input: {
  workspaceId: string;
  sessionId: string;
  branchId: string;
  prompt: string;
  baseline: WorkspaceSnapshot;
  entryId?: string;
}): TaskDomainEvent {
  const clipped = clipText(input.prompt, 4_000);
  const prompt = { entryId: input.entryId, preview: clipped.text, sha256: hashText(input.prompt) } satisfies TaskPromptReference;
  return createTaskDomainEvent({
    kind: "task_opened",
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    taskId: randomUUID(),
    branchId: input.branchId,
    payload: {
      goal: clipped.text,
      goalHash: prompt.sha256,
      goalTruncated: clipped.truncated,
      startedFromEntryId: input.entryId,
      baseline: input.baseline,
      recentPrompts: [prompt],
      requirementRevision: 1
    }
  });
}

export function makeTaskPromptEvent(state: PersistedTaskState, prompt: string, entryId?: string): TaskDomainEvent {
  const clipped = clipText(prompt, 1_200);
  return createTaskDomainEvent({
    kind: "task_prompt",
    workspaceId: state.workspaceId,
    sessionId: state.sessionId,
    taskId: state.taskId,
    branchId: state.branchId,
    payload: { prompt: { entryId, preview: clipped.text, sha256: hashText(prompt) } satisfies TaskPromptReference }
  });
}

export function reduceTaskBranch(entries: readonly PiEntryLike[], workspaceId: string): TaskProjection {
  let active: PersistedTaskState | undefined;
  let latest: PersistedTaskState | undefined;
  const issues: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== taskDomainEntryType) continue;
    const parsed = parseTaskDomainEvent(entry.data);
    if (!parsed.ok) {
      issues.push(parsed.reason);
      continue;
    }
    const event = parsed.event;
    if (event.workspaceId !== workspaceId) {
      issues.push(`Ignored task state from a different workspace (${event.workspaceId}).`);
      continue;
    }
    if (event.kind === "task_opened") {
      const opened = taskStateFromOpenEvent(event, typeof entry.id === "string" ? entry.id : undefined);
      if (!opened) {
        issues.push(`Ignored invalid task_opened event ${event.eventId}.`);
        continue;
      }
      active = opened;
      latest = opened;
      continue;
    }
    if (!active || active.status !== "active" || event.taskId !== active.taskId) continue;
    active = applyTaskDomainEvent(active, event);
    latest = active;
    if (event.kind === "task_closed") active = undefined;
  }
  return { active, latest, issues };
}

export function openTaskState(event: TaskDomainEvent, entryId?: string): PersistedTaskState | undefined {
  if (event.kind !== "task_opened") return undefined;
  return taskStateFromOpenEvent(event, entryId);
}

export function extendTaskProjection(projection: TaskProjection, event: TaskDomainEvent): TaskProjection {
  if (event.kind === "task_opened") {
    const opened = taskStateFromOpenEvent(event);
    return opened ? { active: opened, latest: opened, issues: projection.issues } : projection;
  }
  const current = projection.active ?? projection.latest;
  if (!current || event.taskId !== current.taskId || event.workspaceId !== current.workspaceId) return projection;
  const updated = applyTaskDomainEvent(current, event);
  return event.kind === "task_closed"
    ? { latest: updated, issues: projection.issues }
    : { active: updated, latest: updated, issues: projection.issues };
}

export function applyTaskDomainEvent(state: PersistedTaskState, event: TaskDomainEvent): PersistedTaskState {
  if (event.workspaceId !== state.workspaceId || event.taskId !== state.taskId) return state;
  const payload = event.payload;
  switch (event.kind) {
    case "task_opened":
      return state;
    case "task_prompt": {
      const prompt = parsePromptReference(payload.prompt);
      if (!prompt) return { ...state, recoveryWarning: "A task prompt record could not be restored." };
      return {
        ...state,
        sessionId: event.sessionId,
        requirementRevision: state.requirementRevision + 1,
        recentPrompts: [...state.recentPrompts, prompt].slice(-9),
        lastAssessment: undefined,
        verificationIds: [],
        completionClaim: undefined,
        taskVerdict: "unjudged",
        taskVerdictSource: undefined,
        taskVerdictReason: "A new requirement revision needs its own acceptance decision.",
        verdictRequirementRevision: undefined
      };
    }
    case "task_branch":
      return { ...state, sessionId: event.sessionId, branchId: event.branchId };
    case "run_started":
      return { ...state, latestRunId: event.runId, latestRunStatus: "running" };
    case "workflow_snapshot": {
      const workflow = parseWorkflowSnapshot(payload.workflow);
      return workflow ? { ...state, workflow } : { ...state, recoveryWarning: "The saved workflow state is invalid; older branch state was retained." };
    }
    case "tool_started": {
      if (!event.toolCallId || !event.toolName) return state;
      if (state.outstandingTools.some((tool) => tool.toolCallId === event.toolCallId)) return state;
      return { ...state, outstandingTools: [...state.outstandingTools, { toolCallId: event.toolCallId, toolName: event.toolName, runId: event.runId }] };
    }
    case "tool_finished":
      return event.toolCallId
        ? { ...state, outstandingTools: state.outstandingTools.filter((tool) => tool.toolCallId !== event.toolCallId) }
        : state;
    case "verification":
      return typeof payload.verificationId === "string"
        ? { ...state, verificationIds: [...new Set([...state.verificationIds, payload.verificationId])] }
        : state;
    case "completion_claim":
      return ["claimed_complete", "not_claimed", "unknown"].includes(String(payload.status))
        ? { ...state, completionClaim: {
            status: payload.status as "claimed_complete" | "not_claimed" | "unknown",
            preview: typeof payload.preview === "string" ? payload.preview.slice(0, 300) : "",
            runId: event.runId
          } }
        : state;
    case "task_verdict": {
      const verdict = payload.verdict;
      if (verdict !== "accepted" && verdict !== "rejected" && verdict !== "unjudged") return state;
      return {
        ...state,
        taskVerdict: verdict,
        taskVerdictSource: payload.source === "human" || payload.source === "oracle" ? payload.source : undefined,
        taskVerdictReason: typeof payload.reason === "string" ? payload.reason.slice(0, 1_000) : "",
        verdictRequirementRevision: state.requirementRevision
      };
    }
    case "run_finished": {
      const status = parseRunStatus(payload.runtimeStatus);
      const lastAssessment = parseAssessment(payload.assessment);
      return { ...state, latestRunId: event.runId, latestRunStatus: status, lastAssessment: lastAssessment ?? state.lastAssessment };
    }
    case "run_interrupted":
      return { ...state, latestRunId: event.runId ?? state.latestRunId, latestRunStatus: "interrupted", recoveryWarning: "The prior run stopped before its result was confirmed. Inspect unfinished side effects before retrying." };
    case "task_closed":
      return { ...state, status: "closed" };
  }
}

export function formatTaskContinuity(state: PersistedTaskState, currentPrompt: string, maxChars = 5_000): string {
  const prompts = state.recentPrompts.map((prompt) => prompt.preview).filter(Boolean);
  const priorPrompts = prompts.slice(0, -1).slice(-4);
  const plan = state.workflow?.state.plan;
  const changedFiles = state.workflow?.state.changedFiles.slice(-12) ?? [];
  const checks = state.workflow?.state.checks.slice(-8) ?? [];
  const criticalSections = [
    `Task ${state.taskId} is still active (requirement revision ${state.requirementRevision}).`,
    `Current user message:\n${currentPrompt}`,
    `Initial goal:\n${state.goal}${state.goalTruncated ? "\n[Initial goal excerpt; refer to the Pi session transcript for the full message.]" : ""}`,
    state.recoveryWarning ? `Recovery warning: ${state.recoveryWarning}` : "",
    state.outstandingTools.length > 0
      ? `Unconfirmed tool actions:\n${state.outstandingTools.map((tool) => `- ${tool.toolName} (${tool.toolCallId})`).join("\n")}`
      : "",
    plan ? `Current plan (${plan.summary}):\n${plan.content || plan.steps.map((step) => `- ${step}`).join("\n")}` : "",
    state.lastAssessment ? `Latest evidence (${state.lastAssessment.evidenceStatus}, revision ${state.verdictRequirementRevision ?? "unknown"}): ${state.lastAssessment.reason}` : "Task acceptance remains unjudged until a human or independent oracle records a verdict."
  ];
  const supportingSections = [
    priorPrompts.length > 0 ? `Later user constraints:\n${priorPrompts.map((prompt) => `- ${prompt}`).join("\n")}` : "",
    changedFiles.length > 0 ? `Recorded edits (historical; recheck the live workspace):\n${changedFiles.map((file) => `- ${file.path} via ${file.tool}`).join("\n")}` : "",
    checks.length > 0 ? `Prior checks (revalidate against current files before relying on them):\n${checks.map((check) => `- ${check.ok ? "passed" : "failed"}: ${check.command}`).join("\n")}` : "",
    state.completionClaim ? `Last model completion claim: ${state.completionClaim.status}${state.completionClaim.preview ? ` — ${state.completionClaim.preview}` : ""}. This is a model statement, not task acceptance.` : "",
    state.taskVerdict !== "unjudged" ? `Current requirement verdict: ${state.taskVerdict} (${state.taskVerdictSource ?? "source unavailable"})${state.taskVerdictReason ? ` — ${state.taskVerdictReason}` : ""}.` : ""
  ].filter(Boolean);
  const sections: string[] = [];
  let remaining = Math.max(0, maxChars);
  const required = criticalSections.filter(Boolean);
  for (let index = 0; index < required.length; index += 1) {
    const section = required[index]!;
    const separators = (required.length - index - 1) * 2;
    const fieldBudget = Math.max(0, Math.floor((remaining - separators) / (required.length - index)));
    const bounded = clipStructuredField(section, fieldBudget);
    if (bounded) sections.push(bounded);
    remaining -= bounded.length + (index < required.length - 1 ? 2 : 0);
  }
  for (const section of supportingSections.filter(Boolean)) {
    const separator = sections.length > 0 ? "\n\n" : "";
    if (section.length + separator.length <= remaining) {
      sections.push(section);
      remaining -= section.length + separator.length;
    }
  }
  if (sections.length === 0) return "";
  return sections.join("\n\n");
}

function clipStructuredField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 48) return value.slice(0, maxChars);
  const marker = "\n[… field clipped; full text remains in the Pi transcript …]\n";
  const available = maxChars - marker.length;
  const head = Math.ceil(available * 0.75);
  return `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`;
}

export function updateTaskState(
  state: PersistedTaskState,
  event: TaskDomainEvent
): PersistedTaskState {
  return applyTaskDomainEvent(state, event);
}

function taskStateFromOpenEvent(event: TaskDomainEvent, entryId?: string): PersistedTaskState | undefined {
  const { payload } = event;
  if (typeof payload.goal !== "string" || typeof payload.goalHash !== "string") return undefined;
  const baseline = parseBaseline(payload.baseline);
  if (!baseline) return undefined;
  const prompts = Array.isArray(payload.recentPrompts)
    ? payload.recentPrompts.map(parsePromptReference).filter((prompt): prompt is TaskPromptReference => Boolean(prompt))
    : [];
  return {
    schemaVersion: 1,
    taskId: event.taskId,
    workspaceId: event.workspaceId,
    sessionId: event.sessionId,
    branchId: event.branchId,
    status: "active",
    openedAt: event.at,
    startedFromEntryId: typeof payload.startedFromEntryId === "string" ? payload.startedFromEntryId : entryId,
    goal: payload.goal,
    goalHash: payload.goalHash,
    goalTruncated: payload.goalTruncated === true,
    baseline,
    requirementRevision: Number.isInteger(payload.requirementRevision) ? Number(payload.requirementRevision) : 1,
    recentPrompts: prompts,
    outstandingTools: [],
    verificationIds: [],
    taskVerdict: "unjudged"
  };
}

function parseTaskDomainEvent(value: unknown): { ok: true; event: TaskDomainEvent } | { ok: false; reason: string } {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.eventId !== "string"
    || !eventKinds.has(value.kind as TaskDomainEventKind) || typeof value.workspaceId !== "string"
    || typeof value.sessionId !== "string" || typeof value.taskId !== "string" || typeof value.branchId !== "string"
    || typeof value.at !== "string" || !isRecord(value.payload)) {
    return { ok: false, reason: "Ignored a malformed Actlume task state entry (unsupported schema or missing identity)." };
  }
  return { ok: true, event: value as unknown as TaskDomainEvent };
}

function parseBaseline(value: unknown): WorkspaceSnapshot | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.workspace !== "string"
    || !Array.isArray(value.files) || !(typeof value.fingerprint === "string" || value.fingerprint === null)) return undefined;
  return value as unknown as WorkspaceSnapshot;
}

function parsePromptReference(value: unknown): TaskPromptReference | undefined {
  if (!isRecord(value) || typeof value.preview !== "string" || typeof value.sha256 !== "string") return undefined;
  return { entryId: typeof value.entryId === "string" ? value.entryId : undefined, preview: value.preview, sha256: value.sha256 };
}

function parseWorkflowSnapshot(value: unknown): PiRunWorkflowSnapshot | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.state) || !Array.isArray(value.history)) return undefined;
  if (typeof value.state.runId !== "string" || !Array.isArray(value.state.changedFiles) || !Array.isArray(value.state.checks)) return undefined;
  return value as unknown as PiRunWorkflowSnapshot;
}

function parseRunStatus(value: unknown): PersistedTaskState["latestRunStatus"] {
  return ["running", "completed", "failed", "cancelled", "interrupted", "budget_exhausted", "unknown"].includes(String(value))
    ? value as PersistedTaskState["latestRunStatus"]
    : "unknown";
}

function parseAssessment(value: unknown): TaskAssessment | undefined {
  if (!isRecord(value) || typeof value.reason !== "string" || !Array.isArray(value.changedFiles)) return undefined;
  if (["unchecked", "checks_passed", "checks_failed", "stale", "unknown"].includes(String(value.evidenceStatus))
    && ["accepted", "rejected", "unjudged"].includes(String(value.taskVerdict))) {
    return value as unknown as TaskAssessment;
  }
  if (["verified", "unverified", "no_change", "failed"].includes(String(value.outcome))) {
    return {
      evidenceStatus: "unknown",
      taskVerdict: "unjudged",
      reason: `Historical outcome '${String(value.outcome)}' is preserved as legacy data and is not promoted to current check evidence or a task verdict. ${value.reason}`,
      changedFiles: value.changedFiles.filter((path): path is string => typeof path === "string")
    };
  }
  return undefined;
}

function clipText(value: string, maxChars: number): { text: string; truncated: boolean } {
  return value.length <= maxChars
    ? { text: value, truncated: false }
    : { text: `${value.slice(0, maxChars)}\n[truncated; consult the Pi session transcript for the full prompt]`, truncated: true };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
