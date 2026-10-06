import assert from "node:assert/strict";
import test from "node:test";
import { buildContextPack, resolveInjectedContextBudget } from "./context-budget.js";

test("Actlume context pack stays inside its estimate and reserves selected-memory capacity", () => {
  const project = "P".repeat(70_000);
  const memory = "M".repeat(9_000);
  const pack = buildContextPack(project, memory, 3_000);
  assert.equal(pack.truncated, true);
  assert.ok(pack.usedTokens <= pack.maxTokens);
  assert.ok(pack.text.includes("P".repeat(100)));
  assert.ok(pack.text.includes("M".repeat(100)));
  assert.ok(pack.text.includes("[Actlume context section truncated"));
  assert.equal(pack.sourceChars, project.length + memory.length + 2);
});

test("Actlume context pack leaves short project instructions and memory intact", () => {
  const pack = buildContextPack("Project rules", "Verified command: npm test", 500);
  assert.equal(pack.truncated, false);
  assert.equal(pack.usedTokens, Math.ceil(("Project rules\n\nVerified command: npm test").length / 4));
});

test("injected context budget follows model metadata and labels fallback estimates", () => {
  assert.deepEqual(resolveInjectedContextBudget(32_000), { maxTokens: 8_000, source: "model_metadata" });
  assert.deepEqual(resolveInjectedContextBudget(128_000), { maxTokens: 12_000, source: "model_metadata" });
  assert.deepEqual(resolveInjectedContextBudget(undefined), { maxTokens: 12_000, source: "default_fallback" });
});
