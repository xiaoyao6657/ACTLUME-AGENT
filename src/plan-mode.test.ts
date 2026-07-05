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
