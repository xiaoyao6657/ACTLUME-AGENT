import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRunWorkflow } from "./pi-workflow.js";
import {
  branchIdentity,
  applyTaskDomainEvent,
  createTaskDomainEvent,
  formatTaskContinuity,
  makeTaskOpenedEvent,
  makeTaskPromptEvent,
  reduceTaskBranch,
  taskDomainEntryType,
  workspaceIdentity
} from "./task-state.js";

const baseline = {
  schemaVersion: 1 as const,
  capturedAt: "2026-10-05T00:00:00.000Z",
  workspace: "/repo",
  files: [{ path: "src/main.ts", status: " M", sha256: "baseline-hash" }],
  fingerprint: "baseline-fingerprint"
};

test("Pi branch projection keeps the original task baseline and excludes records from another branch", () => {
  const workspaceId = workspaceIdentity("/repo");
  const manager = SessionManager.inMemory("/repo");
  const sessionId = manager.getSessionId();
  const opened = makeTaskOpenedEvent({
    workspaceId,
    sessionId,
    branchId: branchIdentity(workspaceId, sessionId, null),
    prompt: "Implement the parser fix",
    baseline,
    entryId: "user-1"
  });
  manager.appendCustomEntry(taskDomainEntryType, opened);
  const taskEntryId = manager.getLeafId();
  assert.ok(taskEntryId);

  const started = createTaskDomainEvent({
    kind: "run_started", workspaceId, sessionId, taskId: opened.taskId,
    branchId: opened.branchId, runId: "run-a"
  });
  manager.appendCustomEntry(taskDomainEntryType, started);
  manager.appendCustomEntry(taskDomainEntryType, createTaskDomainEvent({
    kind: "run_finished", workspaceId, sessionId, taskId: opened.taskId,
    branchId: opened.branchId, runId: "run-a",
    payload: { runtimeStatus: "completed", assessment: { outcome: "unverified", reason: "check required", changedFiles: ["src/main.ts"] } }
  }));
  const branchALeaf = manager.getLeafId();
  assert.ok(branchALeaf);

  manager.branch(taskEntryId);
  const openedState = reduceTaskBranch(manager.getBranch(), workspaceId).active;
  assert.ok(openedState);
  manager.appendCustomEntry(taskDomainEntryType, makeTaskPromptEvent(openedState, "Use the old parser API too", "user-branch-b"));
  const branchB = reduceTaskBranch(manager.getBranch(), workspaceId).active;
  assert.equal(branchB?.taskId, opened.taskId);
  assert.equal(branchB?.baseline?.fingerprint, baseline.fingerprint);
  assert.equal(branchB?.requirementRevision, 2);
  assert.equal(branchB?.latestRunStatus, undefined);

  manager.branch(branchALeaf);
  const branchA = reduceTaskBranch(manager.getBranch(), workspaceId).active;
  assert.equal(branchA?.taskId, opened.taskId);
  assert.equal(branchA?.baseline?.fingerprint, baseline.fingerprint);
  assert.equal(branchA?.requirementRevision, 1);
  assert.equal(branchA?.latestRunStatus, "completed");
  assert.equal(branchA?.lastAssessment?.evidenceStatus, "unknown");
  assert.equal(branchA?.lastAssessment?.taskVerdict, "unjudged");
  assert.match(branchA?.lastAssessment?.reason ?? "", /preserved as legacy data/);
});

test("Pi custom task entries survive reopening a session file", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-task-state-"));
  try {
    const sessionDir = join(workspace, "sessions");
    const manager = SessionManager.create(workspace, sessionDir);
    manager.appendMessage({ role: "user", content: "Implement a small parser fix", timestamp: Date.now() } as any);
    const workspaceId = workspaceIdentity(workspace);
    const sessionId = manager.getSessionId();
    const opened = makeTaskOpenedEvent({
      workspaceId, sessionId,
      branchId: branchIdentity(workspaceId, sessionId, manager.getLeafId()),
      prompt: "Implement a small parser fix", baseline: { ...baseline, workspace }
    });
    manager.appendCustomEntry(taskDomainEntryType, opened);
    const file = manager.getSessionFile();
    assert.ok(file);

    const reopened = SessionManager.open(file, sessionDir, workspace);
    const projection = reduceTaskBranch(reopened.getBranch(), workspaceId);
    assert.equal(projection.active?.taskId, opened.taskId);
    assert.equal(projection.active?.goal, "Implement a small parser fix");
    assert.equal(projection.active?.baseline?.fingerprint, baseline.fingerprint);
    assert.deepEqual(projection.issues, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("task recovery rejects malformed entries and state from another workspace", () => {
  const workspaceId = workspaceIdentity("/repo-a");
  const sessionId = "session-a";
  const valid = makeTaskOpenedEvent({
    workspaceId: workspaceIdentity("/repo-b"), sessionId,
    branchId: branchIdentity(workspaceId, sessionId, null), prompt: "unrelated", baseline
  });
  const projection = reduceTaskBranch([
    { type: "custom", customType: taskDomainEntryType, data: { schemaVersion: 99 } },
    { type: "custom", customType: taskDomainEntryType, data: valid }
  ], workspaceId);
  assert.equal(projection.active, undefined);
  assert.equal(projection.issues.length, 2);
});

test("task continuity restores the plan text but labels historical checks as needing revalidation", () => {
  const workspaceId = workspaceIdentity("/repo");
  const sessionId = "session-plan";
  const opened = makeTaskOpenedEvent({
    workspaceId, sessionId, branchId: branchIdentity(workspaceId, sessionId, null),
    prompt: "Refactor the parser without changing its public API", baseline
  });
  const workflow = new PiRunWorkflow("run-one");
  workflow.record("writePlan", { title: "Parser refactor", content: "1. Preserve exports\n2. Add regression coverage", steps: ["Preserve exports", "Add regression coverage"] }, { isError: false, content: "saved" });
  workflow.record("shell", { command: "npm test" }, { isError: false, content: "passed", details: { metadata: { result: { exitCode: 0 } } } });
  const projection = reduceTaskBranch([
    { type: "custom", customType: taskDomainEntryType, data: opened },
    { type: "custom", customType: taskDomainEntryType, data: createTaskDomainEvent({
      kind: "workflow_snapshot", workspaceId, sessionId, taskId: opened.taskId, branchId: opened.branchId,
      runId: "run-one", payload: { workflow: workflow.snapshot() }
    }) }
  ], workspaceId);
  assert.match(formatTaskContinuity(projection.active!, "continue"), /1\. Preserve exports/);
  assert.match(formatTaskContinuity(projection.active!, "continue"), /revalidate against current files/);
});

test("a human verdict is explicit and a new requirement revision resets it", () => {
  const workspaceId = workspaceIdentity("/repo");
  const sessionId = "session-verdict";
  const opened = makeTaskOpenedEvent({
    workspaceId, sessionId, branchId: branchIdentity(workspaceId, sessionId, null),
    prompt: "Fix the parser", baseline
  });
  const initial = reduceTaskBranch([{ type: "custom", customType: taskDomainEntryType, data: opened }], workspaceId).active!;
  const accepted = applyTaskDomainEvent(initial, createTaskDomainEvent({
    kind: "task_verdict", workspaceId, sessionId, taskId: initial.taskId, branchId: initial.branchId,
    payload: { verdict: "accepted", source: "human", reason: "Reviewed the final behavior." }
  }));
  assert.equal(accepted.taskVerdict, "accepted");
  assert.equal(accepted.taskVerdictSource, "human");
  const evidenceBearing = {
    ...accepted,
    lastAssessment: { evidenceStatus: "checks_passed" as const, taskVerdict: "accepted" as const, reason: "old revision", changedFiles: ["parser.ts"] },
    verificationIds: ["verification-old"],
    completionClaim: { status: "claimed_complete" as const, preview: "Done", runId: "run-old" }
  };
  const revised = applyTaskDomainEvent(evidenceBearing, makeTaskPromptEvent(evidenceBearing, "Also preserve the legacy export"));
  assert.equal(revised.requirementRevision, 2);
  assert.equal(revised.taskVerdict, "unjudged");
  assert.equal(revised.taskVerdictSource, undefined);
  assert.equal(revised.lastAssessment, undefined);
  assert.deepEqual(revised.verificationIds, []);
  assert.equal(revised.completionClaim, undefined);
});

test("task continuity truncates within fields while preserving current prompt, recovery, unresolved action, plan, and evidence labels", () => {
  const workspaceId = workspaceIdentity("/repo");
  const sessionId = "session-context-priority";
  const opened = makeTaskOpenedEvent({
    workspaceId, sessionId, branchId: branchIdentity(workspaceId, sessionId, null),
    prompt: "G".repeat(1_500), baseline
  });
  const state = reduceTaskBranch([{ type: "custom", customType: taskDomainEntryType, data: opened }], workspaceId).active!;
  const workflow = new PiRunWorkflow("run-context-priority");
  workflow.record("editPlan", { summary: "Parser plan", expectedFiles: ["parser.ts"], steps: ["Inspect", "Edit"] }, { isError: false });
  const continuity = formatTaskContinuity({
    ...state,
    recoveryWarning: "Check whether the previous file write completed before retrying.",
    outstandingTools: [{ toolCallId: "tool-pending", toolName: "writeFile", runId: "run-old" }],
    workflow: workflow.snapshot(),
    lastAssessment: { evidenceStatus: "unknown", taskVerdict: "unjudged", reason: "Check records need rerun.", changedFiles: ["parser.ts"] }
  }, "CURRENT REQUIREMENT: preserve empty optional values", 900);

  assert.ok(continuity.length <= 900);
  assert.match(continuity, /requirement revision 1/);
  assert.match(continuity, /Current user message:/);
  assert.match(continuity, /Initial goal:/);
  assert.match(continuity, /Recovery warning:/);
  assert.match(continuity, /Unconfirmed tool actions:/);
  assert.match(continuity, /Current plan \(Parser plan\):/);
  assert.match(continuity, /Latest evidence \(unknown/);
  assert.match(continuity, /field clipped/);
});
