import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicyConfig, getPolicyRule, loadPolicyConfig, parsePolicyConfig, policyConfigHash } from "./policy-config.js";

test("policy layers default to enforce and can be independently disabled or observed", () => {
  const config = parsePolicyConfig({
    schemaVersion: 1,
    rules: {
      "actlume.workflow.efficiency": { version: "1.0.0", mode: "disabled" },
      "actlume.task.scope-precheck": { version: "1.0.0", mode: "observe" }
    }
  });
  assert.equal(getPolicyRule(config, "actlume.workflow.efficiency").layer, "efficiency");
  assert.equal(getPolicyRule(config, "actlume.workflow.efficiency").mode, "disabled");
  assert.equal(getPolicyRule(config, "actlume.task.scope-precheck").layer, "task-specific");
  assert.equal(getPolicyRule(config, "actlume.task.scope-precheck").mode, "observe");
  assert.notEqual(policyConfigHash(config), policyConfigHash(defaultPolicyConfig));
});

test("policy config rejects unknown IDs and rule versions instead of silently applying defaults", () => {
  assert.throws(() => parsePolicyConfig({ schemaVersion: 1, rules: { "actlume.workflow.typo": { version: "1.0.0", mode: "disabled" } } }), /Unknown policy rule id/);
  assert.throws(() => parsePolicyConfig({ schemaVersion: 1, rules: { "actlume.workflow.efficiency": { version: "0.9.0", mode: "disabled" } } }), /requires version/);
});

test("policy loader reads project rules and defaults only when no local file exists", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-policy-config-"));
  try {
    assert.deepEqual(await loadPolicyConfig(workspace), defaultPolicyConfig);
    await mkdir(join(workspace, ".actlume"), { recursive: true });
    await writeFile(join(workspace, ".actlume", "policies.json"), JSON.stringify({
      schemaVersion: 1,
      rules: { "actlume.workflow.efficiency": { version: "1.0.0", mode: "observe" } }
    }));
    const loaded = await loadPolicyConfig(workspace);
    assert.equal(getPolicyRule(loaded, "actlume.workflow.efficiency").mode, "observe");
    assert.equal(getPolicyRule(loaded, "actlume.task.scope-precheck").mode, "enforce");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
