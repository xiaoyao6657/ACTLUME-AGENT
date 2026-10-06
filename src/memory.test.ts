import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildMemoryPromptSection, buildRelevantMemoryContext, captureMemoryApplicability, captureMemoryIdentity, getUserMemoryDir, hasUserMemoryConsent, listMemories, promoteUserMemory, recallMemories, recallMemoriesDetailed, saveMemory, setMemoryStatus, revokeUserMemoryConsent } from "./memory.js";
import { defaultSecurityPolicy } from "./security.js";
import { runRegisteredTool } from "./tool-scheduler.js";
import { readRuntimeEvents } from "./runtime-events.js";
import { tools } from "./tools/registry.js";
import type { ToolContext } from "./types.js";

test("saves, indexes, and recalls typed memories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actlume-memory-"));
  try {
    const memory = await saveMemory(dir, {
      type: "project",
      name: "GraphQL migration",
      description: "API migration deadline",
      content: "Move REST endpoints to GraphQL before Q2.",
      status: "active",
      evidenceType: "verified",
      sourceRefs: ["reviewed-by-user"]
    }, { workspace: dir });

    const memories = await listMemories(dir);
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.filename, memory.filename);
    assert.equal(memories[0]?.schemaVersion, 3);
    assert.equal(memories[0]?.status, "active");

    const recalled = await recallMemories(dir, "GraphQL deadline", 5, dir);
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0]?.name, "GraphQL migration");

    const index = await readFile(join(dir, "memories", "MEMORY.md"), "utf8");
    assert.match(index, /GraphQL migration/);

    const prompt = await buildMemoryPromptSection(dir);
    assert.match(prompt, /Typed Memory/);
    assert.match(prompt, /GraphQL migration/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory tools save and recall typed memories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "actlume-memory-tool-"));
  try {
    const ctx: ToolContext = {
      cwd,
      memoryDir: join(cwd, ".agent-memory"),
      readonly: false,
      runId: "memory-run",
      sessionId: "memory-session",
      taskId: "memory-task",
      branchId: "memory-branch",
      permissionMode: "default",
      securityPolicy: defaultSecurityPolicy
    };

    const saved = await runRegisteredTool(tools, "memorySave", {
      type: "feedback",
      name: "style preference",
      description: "Functional style",
      content: "Prefer map/filter over loops."
    }, ctx);
    assert.equal(saved.ok, true);

    const candidateNotInjected = await recallMemories(ctx.memoryDir, "functional loops", 5, cwd);
    assert.equal(candidateNotInjected.length, 0);
    const candidate = (await listMemories(ctx.memoryDir))[0];
    assert.ok(candidate);
    assert.equal(candidate.status, "candidate");
    await setMemoryStatus(ctx.memoryDir, candidate.filename, "active", "user_confirmed");
    const recalled = await runRegisteredTool(tools, "memoryRecall", { query: "functional loops" }, ctx);
    assert.equal(recalled.ok, true);
    assert.match(recalled.content, /map\/filter/);
    const recallEvent = (await readRuntimeEvents(ctx.memoryDir, "memory-session")).find((event) => event.kind === "memory_retrieved");
    assert.equal(recallEvent?.attributes?.retrievalSource, "memoryRecall");
    assert.equal(recallEvent?.taskId, "memory-task");
    assert.ok((recallEvent?.attributes?.selected as string[] | undefined)?.some((item) => item.includes(candidate.filename)));
    assert.match(String(recallEvent?.attributes?.queryHash), /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(recallEvent).includes("functional loops"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("relevant memory context carries type and source provenance within a bounded size", () => {
  const context = buildRelevantMemoryContext([{
    name: "database decision",
    description: "Storage choice",
    type: "project",
    filename: "project_database_decision.md",
    content: "Use SQLite for local task state."
  }]);

  assert.match(context, /Retrieved Actlume Memories/);
  assert.match(context, /project; legacy scope; needs_review; legacy evidence; source: project_database_decision.md/);
  assert.match(context, /Use SQLite/);

  const bounded = buildRelevantMemoryContext([{
    name: "long note",
    description: "Large body",
    type: "reference",
    filename: "reference_long_note.md",
    content: "x".repeat(500)
  }], 260);
  assert.ok(bounded.length <= 260);
  assert.match(bounded, /truncated/);
});

test("legacy memory without lifecycle metadata is kept for review and never injected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actlume-memory-legacy-"));
  try {
    await mkdir(join(dir, "memories"), { recursive: true });
    await writeFile(join(dir, "memories", "project_old_note.md"), [
      "---",
      "name: Old convention",
      "description: A legacy note",
      "type: project",
      "---",
      "",
      "Use the old deployment command.",
      ""
    ].join("\n"));
    const entries = await listMemories(dir);
    assert.equal(entries[0]?.schemaVersion, 1);
    assert.equal(entries[0]?.status, "needs_review");
    assert.deepEqual(await recallMemories(dir, "deployment command"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsupported memory schemas remain visible for review and cannot become active recall", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actlume-memory-future-schema-"));
  try {
    await mkdir(join(dir, "memories"), { recursive: true });
    await writeFile(join(dir, "memories", "project_future.md"), [
      "---",
      "name: Future format",
      "description: Unsupported schema fixture",
      "type: project",
      "schemaVersion: 99",
      "status: active",
      "evidenceType: user_confirmed",
      "---",
      "",
      "This must not be injected as trusted memory.",
      ""
    ].join("\n"));
    const [entry] = await listMemories(dir);
    assert.equal(entry?.schemaVersion, 99);
    assert.equal(entry?.status, "needs_review");
    assert.match(entry?.schemaWarning ?? "", /Unsupported memory schema version/);
    assert.deepEqual(await recallMemories(dir, "trusted memory"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("active memory is invalidated when a referenced project file changes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-memory-stale-"));
  const memoryDir = join(workspace, ".agent-memory");
  try {
    await writeFile(join(workspace, "package.json"), "{\"scripts\":{\"test\":\"vitest\"}}\n");
    const applicability = await captureMemoryApplicability(workspace, ["package.json"]);
    const entry = await saveMemory(memoryDir, {
      type: "project",
      name: "Test command",
      description: "Verified project test command",
      content: "Run npm test.",
      status: "active",
      evidenceType: "verified",
      sourceRefs: ["package.json"],
      applicability
    }, { workspace });
    assert.equal((await recallMemories(memoryDir, "test command", 5, workspace))[0]?.filename, entry.filename);

    await writeFile(join(workspace, "package.json"), "{\"scripts\":{\"test\":\"jest\"}}\n");
    assert.deepEqual(await recallMemories(memoryDir, "test command", 5, workspace), []);
    assert.equal((await listMemories(memoryDir))[0]?.status, "needs_review");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("repository, worktree, and task memories are recalled only for matching identities", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-memory-identity-"));
  const memoryDir = join(workspace, ".agent-memory");
  const repositoryIdentity = { repositoryId: "repo-a", worktreeId: "worktree-a" };
  try {
    const worktreeMemory = await saveMemory(memoryDir, {
      type: "project", name: "Worktree convention", description: "Per checkout", content: "Use the isolated build directory.",
      scope: "worktree", status: "active", evidenceType: "user_confirmed", identity: repositoryIdentity
    }, { identity: repositoryIdentity });
    const taskIdentity = { ...repositoryIdentity, taskId: "task-a", sessionId: "session-a", branchId: "branch-a" };
    const taskMemory = await saveMemory(memoryDir, {
      type: "reference", name: "Task decision", description: "Branch-local decision", content: "Keep the parser fallback.",
      scope: "task", status: "active", evidenceType: "user_confirmed", identity: taskIdentity
    }, { identity: taskIdentity });

    assert.equal((await recallMemories(memoryDir, "isolated build", 5, workspace, repositoryIdentity))[0]?.filename, worktreeMemory.filename);
    assert.deepEqual(await recallMemories(memoryDir, "isolated build", 5, workspace, { repositoryId: "repo-a", worktreeId: "worktree-b" }), []);
    assert.equal((await recallMemories(memoryDir, "parser fallback", 5, workspace, taskIdentity))[0]?.filename, taskMemory.filename);
    const otherBranchResults = await recallMemories(memoryDir, "parser fallback", 5, workspace, { ...taskIdentity, branchId: "branch-b" });
    assert.equal(otherBranchResults.some((entry) => entry.filename === taskMemory.filename), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("supersedes removes old active recall only after same-scope human promotion", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-memory-supersedes-"));
  const memoryDir = join(workspace, ".agent-memory");
  const identity = { repositoryId: "repo-a", worktreeId: "worktree-a" };
  try {
    const old = await saveMemory(memoryDir, {
      type: "project", name: "Build command", description: "Old verified command", content: "Run npm test.",
      scope: "repository", status: "active", evidenceType: "verified", identity
    }, { identity });
    const replacement = await saveMemory(memoryDir, {
      type: "project", name: "Build command v2", description: "Replacement command", content: "Run npm run test:unit.",
      scope: "repository", status: "candidate", evidenceType: "candidate", identity, supersedes: [old.id!]
    }, { identity });
    assert.deepEqual((await recallMemories(memoryDir, "npm test", 5, workspace, identity)).map((entry) => entry.filename), [old.filename]);

    const promoted = await setMemoryStatus(memoryDir, replacement.filename, "active", "user_confirmed");
    assert.equal(promoted?.status, "active");
    assert.equal((await listMemories(memoryDir)).find((entry) => entry.filename === old.filename)?.status, "superseded");
    assert.deepEqual((await recallMemories(memoryDir, "npm run test unit", 5, workspace, identity)).map((entry) => entry.filename), [replacement.filename]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cross-scope supersedes conflicts remain in needs_review instead of using timestamps to choose truth", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-memory-conflict-"));
  const memoryDir = join(workspace, ".agent-memory");
  const identity = { repositoryId: "repo-a", worktreeId: "worktree-a" };
  try {
    const repositoryMemory = await saveMemory(memoryDir, {
      type: "project", name: "Storage decision", description: "Repository source", content: "Use SQLite.",
      scope: "repository", status: "active", evidenceType: "verified", identity
    }, { identity });
    const worktreeCandidate = await saveMemory(memoryDir, {
      type: "project", name: "Storage override", description: "Worktree-local claim", content: "Use JSON.",
      scope: "worktree", status: "candidate", evidenceType: "candidate", identity, supersedes: [repositoryMemory.id!]
    }, { identity });

    const reviewed = await setMemoryStatus(memoryDir, worktreeCandidate.filename, "active", "user_confirmed");
    assert.equal(reviewed?.status, "needs_review");
    assert.match(reviewed?.reviewReason ?? "", /different memory scope or identity/);
    assert.equal((await listMemories(memoryDir)).find((entry) => entry.filename === repositoryMemory.filename)?.status, "active");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("user-scoped memory crosses workspaces only after explicit promotion consent and can be revoked", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-memory-user-"));
  const secondWorkspace = await mkdtemp(join(tmpdir(), "actlume-memory-user-second-"));
  const memoryDir = join(workspace, ".agent-memory");
  const userStore = join(workspace, ".isolated-user-store");
  try {
    const candidate = await saveMemory(memoryDir, {
      type: "user", name: "Answer preference", description: "User-approved response preference", content: "Prefer concise technical answers.",
      scope: "user", status: "candidate", evidenceType: "candidate", identity: { repositoryId: "repo-a", worktreeId: "worktree-a" }
    }, { identity: { repositoryId: "repo-a", worktreeId: "worktree-a" } });
    assert.equal(await hasUserMemoryConsent(userStore), false);
    assert.deepEqual(await recallMemories(memoryDir, "concise technical answers", 5, workspace, undefined, userStore), []);

    const promoted = await promoteUserMemory(memoryDir, candidate.filename, userStore);
    assert.equal(promoted?.scope, "user");
    assert.equal(promoted?.status, "active");
    assert.equal(await hasUserMemoryConsent(userStore), true);
    assert.equal((await recallMemories(memoryDir, "concise technical answers", 5, secondWorkspace, undefined, userStore))[0]?.filename, promoted?.filename);

    await revokeUserMemoryConsent(userStore);
    assert.equal(await hasUserMemoryConsent(userStore), false);
    assert.deepEqual(await recallMemories(memoryDir, "concise technical answers", 5, secondWorkspace, undefined, userStore), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(secondWorkspace, { recursive: true, force: true });
  }
});
