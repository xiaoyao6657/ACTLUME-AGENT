import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessTaskOutcome,
  captureWorkspaceSnapshot,
  checkEnvironmentId,
  changedFilesSince,
  classifyVerificationCommand,
  createVerificationRecord,
  loadCheckSpecs,
  matchCheckSpec,
  type CheckSpec
} from "./verification.js";

const execFileAsync = promisify(execFile);

test("CheckSpec config binds evidence to an exact command, cwd, scope and environment manifest", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-check-spec-"));
  try {
    await mkdir(join(workspace, ".actlume"), { recursive: true });
    await writeFile(join(workspace, ".actlume", "checks.json"), JSON.stringify({
      schemaVersion: 1,
      checks: [{ id: "tests", command: "npm test", cwd: ".", kind: "test", scopePaths: ["src"], requiredFiles: ["package.json"], environmentFiles: ["package.json"], environmentKeys: ["NODE_ENV"] }]
    }));
    await writeFile(join(workspace, "package.json"), "{}\n");
    const [spec] = await loadCheckSpecs(workspace);
    assert.ok(spec);
    assert.equal(spec.cwd, workspace);
    assert.equal(matchCheckSpec(workspace, [spec], "npm   test", workspace)?.id, "tests");
    assert.equal(matchCheckSpec(workspace, [spec], "echo npm test", workspace), undefined);
    assert.ok((await checkEnvironmentId(workspace, spec)).length > 20);

    await writeFile(join(workspace, ".actlume", "checks.json"), JSON.stringify({
      schemaVersion: 1,
      checks: [{ id: "escape", command: "npm test", cwd: "../outside", kind: "test" }]
    }));
    await assert.rejects(loadCheckSpecs(workspace), /must stay inside the workspace/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("verification evidence is tied to the working-tree fingerprint and task baseline", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-verification-"));
  try {
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "package.json"), "{\"name\":\"fixture\"}\n");
    await writeFile(join(workspace, "src", "stable.ts"), "export const stable = true;\n");
    await execFileAsync("git", ["init"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.local"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workspace });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: workspace });

    await writeFile(join(workspace, "user-local.txt"), "pre-existing user change\n");
    const memoryDir = join(workspace, ".agent-memory");
    await mkdir(memoryDir, { recursive: true });
    const baseline = await captureWorkspaceSnapshot(workspace, [memoryDir]);
    await writeFile(join(memoryDir, "runtime-events.jsonl"), "runtime-only state\n");
    await writeFile(join(workspace, "src", "stable.ts"), "export const stable = false;\n");
    const afterEdit = await captureWorkspaceSnapshot(workspace, [memoryDir]);
    assert.deepEqual(changedFilesSince(baseline, afterEdit), ["src/stable.ts"]);
    assert.equal(classifyVerificationCommand("npm test"), "test");
    assert.equal(classifyVerificationCommand("git status --short"), undefined);
    assert.equal(classifyVerificationCommand("echo npm test"), undefined, "printing a test command did not run the test suite");

    const checkSpec: CheckSpec = {
      id: "workspace-tests",
      command: "npm test",
      cwd: workspace,
      kind: "test",
      required: true,
      scopePaths: ["src"],
      requiredFiles: ["package.json"],
      environmentFiles: ["package.json"],
      environmentKeys: ["NODE_ENV"]
    };
    const environmentId = await checkEnvironmentId(workspace, checkSpec);
    const record = await createVerificationRecord({
      memoryDir,
      workspace,
      baseline,
      sessionId: "verification-session",
      runId: "run-one",
      taskId: "task-one",
      requirementRevision: 1,
      toolCallId: "tool-one",
      command: "npm test",
      cwd: workspace,
      checkSpec,
      beforeSnapshot: afterEdit,
      requiredFilesAvailableAtStart: true,
      environmentIdAtStart: environmentId,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      exitCode: 0
    });
    assert.ok(record);
    assert.equal(record.ok, true);
    assert.equal(record.evidenceStatus, "checks_passed");
    assert.equal(record.specId, "workspace-tests");
    assert.deepEqual(record.changedFiles, ["src/stable.ts"]);
    const passed = assessTaskOutcome({
      baseline, current: afterEdit, verifications: [record], runId: "run-one", taskId: "task-one",
      requirementRevision: 1,
      checkSpecs: [checkSpec], currentEnvironmentIds: { "workspace-tests": environmentId }
    });
    assert.equal(passed.evidenceStatus, "checks_passed");
    assert.equal(passed.taskVerdict, "unjudged");

    await writeFile(join(workspace, "src", "stable.ts"), "export const stable = 'changed after test';\n");
    const afterUntestedEdit = await captureWorkspaceSnapshot(workspace);
    const stale = assessTaskOutcome({
      baseline, current: afterUntestedEdit, verifications: [record], runId: "run-one", taskId: "task-one",
      requirementRevision: 1,
      checkSpecs: [checkSpec], currentEnvironmentIds: { "workspace-tests": environmentId }
    });
    assert.equal(stale.evidenceStatus, "stale");
    assert.match(stale.reason, /live workspace or check environment/);

    const content = await readFile(join(workspace, ".agent-memory", "verification", "verification-session.jsonl"), "utf8");
    assert.match(content, /"toolCallId":"tool-one"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime completion alone leaves the task verdict unjudged and evidence unchecked", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-no-change-"));
  try {
    await execFileAsync("git", ["init"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.local"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workspace });
    await writeFile(join(workspace, "file.txt"), "unchanged\n");
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: workspace });
    const snapshot = await captureWorkspaceSnapshot(workspace);
    const result = assessTaskOutcome({ baseline: snapshot, current: snapshot, verifications: [], runId: "run", checkSpecs: [], currentEnvironmentIds: {} });
    assert.equal(result.evidenceStatus, "unchecked");
    assert.equal(result.taskVerdict, "unjudged");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("change attribution recognizes agent commits without counting pre-existing dirty content as new work", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-committed-changes-"));
  try {
    await writeFile(join(workspace, "tracked.txt"), "base\n");
    await execFileAsync("git", ["init"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "test@example.local"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workspace });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "pre-existing local change\n");
    const baseline = await captureWorkspaceSnapshot(workspace);
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "preserve existing content"], { cwd: workspace });
    const committedSameContent = await captureWorkspaceSnapshot(workspace);
    assert.deepEqual(changedFilesSince(baseline, committedSameContent), [], "committing the same content already present at task start is not new work");

    await writeFile(join(workspace, "tracked.txt"), "agent added content\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "agent change"], { cwd: workspace });
    const committedNewContent = await captureWorkspaceSnapshot(workspace);
    assert.deepEqual(changedFilesSince(baseline, committedNewContent), ["tracked.txt"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
