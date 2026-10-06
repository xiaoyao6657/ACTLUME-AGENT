import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultSecurityPolicy } from "./security.js";
import { runRegisteredTool } from "./tool-scheduler.js";
import type { ToolContext } from "./types.js";
import { tools } from "./tools/registry.js";

test("plan mode allows writePlan while readonly blocks workspace writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "actlume-plan-"));
  try {
    const ctx: ToolContext = {
      cwd,
      memoryDir: join(cwd, ".agent-memory"),
      readonly: true,
      runId: "plan-run",
      permissionMode: "plan",
      securityPolicy: defaultSecurityPolicy
    };

    const plan = await runRegisteredTool(tools, "writePlan", {
      title: "Test plan",
      content: "1. Inspect\n2. Implement\n3. Verify"
    }, ctx);
    assert.equal(plan.ok, true);

    const read = await runRegisteredTool(tools, "readPlan", {}, ctx);
    assert.equal(read.ok, true);
    assert.match(read.content, /Test plan/);

    const write = await runRegisteredTool(tools, "writeFile", { path: "blocked.txt", content: "nope" }, ctx);
    assert.equal(write.ok, false);
    if (!write.ok) {
      assert.equal(write.errorCode, "READONLY_BLOCKED");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("plans follow task and Pi branch identity across run attempts without leaking to sibling branches", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "actlume-plan-scope-"));
  try {
    const base: ToolContext = {
      cwd,
      memoryDir: join(cwd, ".agent-memory"),
      readonly: false,
      runId: "run-one",
      taskId: "task-a",
      branchId: "branch-a",
      permissionMode: "default",
      securityPolicy: defaultSecurityPolicy
    };
    const written = await runRegisteredTool(tools, "writePlan", { content: "Keep the public API stable." }, base);
    assert.equal(written.ok, true);

    const resumed = await runRegisteredTool(tools, "readPlan", {}, { ...base, runId: "run-two" });
    assert.equal(resumed.ok, true);
    assert.match(resumed.content, /public API stable/);

    const sibling = await runRegisteredTool(tools, "readPlan", {}, { ...base, runId: "run-three", branchId: "branch-b" });
    assert.equal(sibling.ok, false);
    if (!sibling.ok) assert.equal(sibling.errorCode, "PLAN_NOT_FOUND");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
