import assert from "node:assert/strict";
import test from "node:test";
import { PiRunWorkflow } from "./pi-workflow.js";
import { parsePolicyConfig } from "./policy-config.js";
import { classifyActionIntent } from "./workflow-guard.js";

test("Pi workflow guard records run-local plans, edits, checks, and blocks over-budget broad reads", () => {
  const workflow = new PiRunWorkflow("run-a");
  const task = "Implement the requested fix";
  assert.equal(workflow.check("writePlan", { title: "Fix", content: "Change the parser" }, task, 10, "call-plan"), undefined);
  workflow.record("writePlan", { title: "Fix", content: "Change the parser" }, { isError: false }, "call-plan");
  assert.equal(workflow.state.plan?.summary, "Fix");

  for (let i = 0; i < 3; i += 1) {
    const callId = "read-" + i;
    assert.equal(workflow.check("readFile", { path: "src/parser.ts" }, task, 10, callId), undefined);
    workflow.record("readFile", { path: "src/parser.ts" }, { isError: false }, callId);
  }
  const blocked = workflow.check("readFile", { path: "src/parser.ts" }, task, 10, "read-over-budget");
  assert.ok(blocked && !blocked.ok);
  assert.equal(blocked.errorCode, "EXPLORATION_BUDGET_EXCEEDED");
  workflow.record("readFile", { path: "src/parser.ts" }, { isError: true, content: blocked.content, details: { errorCode: blocked.errorCode } }, "read-over-budget");
  assert.match(workflow.history.at(-1)?.observation ?? "", /EXPLORATION_BUDGET_EXCEEDED/);

  const secondRun = new PiRunWorkflow("run-b");
  assert.equal(secondRun.state.plan, undefined);
  assert.equal(secondRun.state.changedFiles.length, 0);
});

test("Pi workflow treats the executable editPlan tool as the plan-stage transition", () => {
  const workflow = new PiRunWorkflow("run-edit-plan");
  const task = "Fix the parser";
  const input = { summary: "Allow empty optional values", expectedFiles: ["parser.js"], steps: ["Relax value match"] };
  assert.equal(workflow.check("editPlan", input, task, 10, "edit-plan"), undefined);
  workflow.record("editPlan", input, { isError: false }, "edit-plan");

  assert.equal(workflow.state.plan?.summary, input.summary);
  assert.deepEqual(workflow.state.plan?.expectedFiles, input.expectedFiles);
  assert.deepEqual(workflow.state.plan?.steps, input.steps);
  assert.equal(workflow.check("writeFile", { path: "parser.js" }, task, 10, "write"), undefined);
});

test("read-only memory tools remain available as inspection after an edit plan", () => {
  const workflow = new PiRunWorkflow("run-memory-inspection");
  const task = "Fix the parser using relevant project memory";
  const plan = { summary: "Fix parser", expectedFiles: ["parser.js"], steps: ["Recall relevant decisions", "Update parser"] };
  workflow.record("editPlan", plan, { isError: false }, "plan");

  for (const tool of ["memoryList", "memoryRecall"]) {
    assert.equal(classifyActionIntent({ type: "action", thought: "", tool, input: {} }), "inspect");
    assert.equal(workflow.check(tool, { query: "parser" }, task, 10, `${tool}-call`), undefined);
  }
});

test("policy treatments independently disable efficiency budgets and task-specific editPlan prechecks", () => {
  const defaultWorkflow = new PiRunWorkflow("run-policy-default");
  const explicitTask = "Please call editPlan first and fix the parser";
  const blockedFirstRead = defaultWorkflow.check("readFile", { path: "parser.js", lineCount: 10 }, explicitTask, 20, "default-read", 1);
  assert.equal(blockedFirstRead?.ok, false);
  assert.equal(blockedFirstRead?.errorCode, "EDIT_PLAN_REQUIRED_FIRST");

  const taskPolicyDisabled = parsePolicyConfig({
    schemaVersion: 1,
    rules: { "actlume.task.scope-precheck": { version: "1.0.0", mode: "disabled" } }
  });
  const taskSpecificWorkflow = new PiRunWorkflow("run-policy-task-disabled");
  assert.equal(taskSpecificWorkflow.check("readFile", { path: "parser.js", lineCount: 10 }, explicitTask, 20, "task-read", 1, taskPolicyDisabled), undefined);

  const efficiencyDisabled = parsePolicyConfig({
    schemaVersion: 1,
    rules: { "actlume.workflow.efficiency": { version: "1.0.0", mode: "disabled" } }
  });
  const efficiencyWorkflow = new PiRunWorkflow("run-policy-efficiency-disabled");
  const plan = { summary: "Fix parser", expectedFiles: ["parser.js"], steps: ["Inspect parser"] };
  efficiencyWorkflow.check("editPlan", plan, "Fix parser", 10, "plan", 1, efficiencyDisabled);
  efficiencyWorkflow.record("editPlan", plan, { isError: false }, "plan");
  assert.equal(efficiencyWorkflow.check("readFile", { path: "parser.js" }, "Fix parser", 10, "late-read", 100, efficiencyDisabled), undefined);
});

test("Pi workflow history follows request order when concurrent tool calls finish out of order", () => {
  const workflow = new PiRunWorkflow("run-order");
  workflow.check("readFile", { path: "a.ts", lineCount: 10 }, "Inspect this code", 10, "call-a");
  workflow.check("readFile", { path: "b.ts", lineCount: 10 }, "Inspect this code", 10, "call-b");
  workflow.record("readFile", { path: "b.ts", lineCount: 10 }, { isError: false, content: "B" }, "call-b");
  workflow.record("readFile", { path: "a.ts", lineCount: 10 }, { isError: false, content: "A" }, "call-a");
  assert.deepEqual(workflow.history.map((item) => item.action.input), [
    { path: "a.ts", lineCount: 10 },
    { path: "b.ts", lineCount: 10 }
  ]);
});

test("Pi workflow snapshot restores plans, check history, and the new attempt identity", () => {
  const workflow = new PiRunWorkflow("run-before-restart");
  workflow.record("writePlan", { title: "Parser fix", content: "Keep the legacy API" }, { isError: false }, "plan-call");
  workflow.check("readFile", { path: "src/parser.ts" }, "Fix the parser", 10, "read-call");
  workflow.record("readFile", { path: "src/parser.ts" }, { isError: false, content: "parser source" }, "read-call");

  const restored = PiRunWorkflow.fromSnapshot("run-after-restart", workflow.snapshot());
  assert.equal(restored.state.runId, "run-after-restart");
  assert.equal(restored.state.plan?.summary, "Parser fix");
  assert.deepEqual(restored.history.map((entry) => entry.action.tool), ["editPlan", "readFile"]);
  assert.equal(restored.history[1]?.action.input && (restored.history[1]?.action.input as any).path, "src/parser.ts");
});
