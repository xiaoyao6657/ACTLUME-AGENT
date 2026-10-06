import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PolicyMode = "enforce" | "observe" | "disabled";
export type PolicyLayer = "efficiency" | "task-specific";
export type PolicyRuleId = "actlume.workflow.efficiency" | "actlume.task.scope-precheck";

export type PolicyRuleDefinition = {
  id: PolicyRuleId;
  version: "1.0.0";
  layer: PolicyLayer;
  defaultMode: PolicyMode;
  description: string;
};

export type PolicyConfig = {
  schemaVersion: 1;
  rules: Record<PolicyRuleId, { version: "1.0.0"; mode: PolicyMode }>;
};

export const policyDefinitions: PolicyRuleDefinition[] = [
  {
    id: "actlume.workflow.efficiency",
    version: "1.0.0",
    layer: "efficiency",
    defaultMode: "enforce",
    description: "Exploration and workflow-stage budgets. Does not control permissions or verification evidence."
  },
  {
    id: "actlume.task.scope-precheck",
    version: "1.0.0",
    layer: "task-specific",
    defaultMode: "enforce",
    description: "Explicit edit-plan-first and repeated issue-target miss prechecks."
  }
];

export const defaultPolicyConfig: PolicyConfig = {
  schemaVersion: 1,
  rules: {
    "actlume.workflow.efficiency": { version: "1.0.0", mode: "enforce" },
    "actlume.task.scope-precheck": { version: "1.0.0", mode: "enforce" }
  }
};

const knownRules = new Set(policyDefinitions.map((rule) => rule.id));

export async function loadPolicyConfig(workspace: string): Promise<PolicyConfig> {
  let raw: string;
  try {
    raw = await readFile(join(workspace, ".actlume", "policies.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(defaultPolicyConfig);
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Failed to parse .actlume/policies.json as JSON."); }
  return parsePolicyConfig(parsed);
}

export function parsePolicyConfig(value: unknown): PolicyConfig {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.rules)) {
    throw new Error("Policy config must contain schemaVersion: 1 and a rules object.");
  }
  for (const id of Object.keys(value.rules)) {
    if (!knownRules.has(id as PolicyRuleId)) throw new Error(`Unknown policy rule id: ${id}`);
  }
  const rules = structuredClone(defaultPolicyConfig.rules);
  for (const definition of policyDefinitions) {
    const override = value.rules[definition.id];
    if (override === undefined) continue;
    if (!isRecord(override) || override.version !== definition.version
      || !["enforce", "observe", "disabled"].includes(String(override.mode))) {
      throw new Error(`Policy rule '${definition.id}' requires version '${definition.version}' and mode enforce, observe, or disabled.`);
    }
    rules[definition.id] = { version: definition.version, mode: override.mode as PolicyMode };
  }
  return { schemaVersion: 1, rules };
}

export function getPolicyRule(config: PolicyConfig | undefined, id: PolicyRuleId): PolicyRuleDefinition & { mode: PolicyMode } {
  const definition = policyDefinitions.find((rule) => rule.id === id)!;
  return { ...definition, mode: config?.rules[id]?.mode ?? definition.defaultMode };
}

export function policyConfigHash(config: PolicyConfig | undefined): string {
  const canonical = policyDefinitions.map((definition) => `${definition.id}@${definition.version}=${getPolicyRule(config, definition.id).mode}`).join("\n");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
