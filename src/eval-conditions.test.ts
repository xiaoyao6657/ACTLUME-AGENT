import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEvalConditionManifest, resolveEvalConditionTreatment } from "./eval-conditions.js";
import { policyConfigHash } from "./policy-config.js";

test("core Eval condition design resolves stable single-factor Actlume treatments", async () => {
  const raw = JSON.parse(await readFile(resolve(process.cwd(), "evals/experiments/core-v1-condition-design.json"), "utf8")) as unknown;
  const manifest = parseEvalConditionManifest(raw);
  const control = resolveEvalConditionTreatment(manifest, "actlume-control");
  const memory = resolveEvalConditionTreatment(manifest, "actlume-memory");
  const guardrails = resolveEvalConditionTreatment(manifest, "actlume-guardrails");
  const full = resolveEvalConditionTreatment(manifest, "actlume-full");

  assert.equal(manifest.status, "design-only-not-frozen");
  assert.equal(control.memoryEnabled, false);
  assert.equal(memory.memoryEnabled, true);
  assert.equal(guardrails.memoryEnabled, false);
  assert.equal(full.memoryEnabled, true);
  assert.equal(policyConfigHash(control.policyConfig), policyConfigHash(memory.policyConfig));
  assert.equal(policyConfigHash(control.policyConfig), "sha256:159fa3c05f032c08bb6dad2079e3b8b849bd034bcd17d4c83be089c3f8e4fdec");
  assert.notEqual(policyConfigHash(control.policyConfig), policyConfigHash(guardrails.policyConfig));
  assert.equal(policyConfigHash(guardrails.policyConfig), policyConfigHash(full.policyConfig));
  assert.throws(() => resolveEvalConditionTreatment(manifest, "pi-native-reference"), /cannot be run through the Actlume runtime/i);
});

test("Eval condition design rejects mislabeled or confounded comparisons", async () => {
  const raw = JSON.parse(await readFile(resolve(process.cwd(), "evals/experiments/core-v1-condition-design.json"), "utf8")) as Record<string, any>;
  const controlWithMemory = structuredClone(raw);
  controlWithMemory.conditions.find((condition: { id: string }) => condition.id === "actlume-control").memory = "enabled";
  assert.throws(() => parseEvalConditionManifest(controlWithMemory), /single-factor treatment/i);

  const confoundedComparison = structuredClone(raw);
  confoundedComparison.primaryComparisons[0].changedFactors.push("policies");
  assert.throws(() => parseEvalConditionManifest(confoundedComparison), /must change exactly memory/i);
});
