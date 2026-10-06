import { parsePolicyConfig, type PolicyConfig, type PolicyMode, type PolicyRuleId } from "./policy-config.js";

export type EvalConditionId = "pi-native-reference" | "actlume-control" | "actlume-memory" | "actlume-guardrails" | "actlume-full";

export type EvalConditionProfile = {
  id: EvalConditionId;
  runtime: "pi-native" | "actlume";
  role: string;
  memory: "native" | "enabled" | "disabled";
  policies: Record<PolicyRuleId, PolicyMode> | null;
};

export type EvalConditionManifest = {
  schemaVersion: 1;
  manifestId: string;
  status: "design-only-not-frozen";
  conditions: EvalConditionProfile[];
  primaryComparisons: Array<{ control: EvalConditionId; treatment: EvalConditionId; changedFactors: Array<"memory" | "policies"> }>;
  limitations: string[];
};

export type EvalConditionTreatment = {
  condition: Exclude<EvalConditionId, "pi-native-reference">;
  memoryEnabled: boolean;
  policyConfig: PolicyConfig;
};

const expectedActlumeConditions: Record<Exclude<EvalConditionId, "pi-native-reference">, {
  memory: "enabled" | "disabled";
  policies: Record<PolicyRuleId, PolicyMode>;
}> = {
  "actlume-control": {
    memory: "disabled",
    policies: { "actlume.workflow.efficiency": "disabled", "actlume.task.scope-precheck": "disabled" }
  },
  "actlume-memory": {
    memory: "enabled",
    policies: { "actlume.workflow.efficiency": "disabled", "actlume.task.scope-precheck": "disabled" }
  },
  "actlume-guardrails": {
    memory: "disabled",
    policies: { "actlume.workflow.efficiency": "enforce", "actlume.task.scope-precheck": "enforce" }
  },
  "actlume-full": {
    memory: "enabled",
    policies: { "actlume.workflow.efficiency": "enforce", "actlume.task.scope-precheck": "enforce" }
  }
};

export function parseEvalConditionManifest(value: unknown): EvalConditionManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.manifestId !== "string"
    || value.status !== "design-only-not-frozen" || !Array.isArray(value.conditions)
    || !Array.isArray(value.primaryComparisons) || !Array.isArray(value.limitations)) {
    throw new Error("Eval condition design must be schemaVersion 1 and explicitly marked design-only-not-frozen.");
  }
  const conditions = value.conditions.map(parseCondition);
  const byId = new Map(conditions.map((condition) => [condition.id, condition]));
  if (byId.size !== conditions.length) throw new Error("Eval condition IDs must be unique.");
  const reference = byId.get("pi-native-reference");
  if (!reference || reference.runtime !== "pi-native" || reference.role !== "descriptive-reference-only"
    || reference.memory !== "native" || reference.policies !== null) {
    throw new Error("pi-native-reference must remain a separate descriptive reference, not a causal Actlume condition.");
  }
  for (const [id, expected] of Object.entries(expectedActlumeConditions)) {
    const condition = byId.get(id as Exclude<EvalConditionId, "pi-native-reference">);
    if (!condition || condition.runtime !== "actlume" || condition.memory !== expected.memory
      || JSON.stringify(condition.policies) !== JSON.stringify(expected.policies)) {
      throw new Error(`Eval condition '${id}' does not match its predeclared single-factor treatment.`);
    }
  }
  const comparisons = value.primaryComparisons.map(parseComparison);
  assertComparison(comparisons, "actlume-control", "actlume-memory", ["memory"]);
  assertComparison(comparisons, "actlume-control", "actlume-guardrails", ["policies"]);
  assertComparison(comparisons, "actlume-control", "actlume-full", ["memory", "policies"]);
  return {
    schemaVersion: 1,
    manifestId: value.manifestId,
    status: "design-only-not-frozen",
    conditions,
    primaryComparisons: comparisons,
    limitations: value.limitations.filter((item): item is string => typeof item === "string")
  };
}

export function resolveEvalConditionTreatment(manifest: EvalConditionManifest, id: string): EvalConditionTreatment {
  if (id === "pi-native-reference") throw new Error("pi-native-reference cannot be run through the Actlume runtime adapter.");
  const condition = manifest.conditions.find((item) => item.id === id);
  if (!condition || condition.runtime !== "actlume" || !condition.policies || condition.memory === "native") {
    throw new Error(`Unknown executable Actlume evaluation condition '${id}'.`);
  }
  const rules = Object.fromEntries(Object.entries(condition.policies).map(([ruleId, mode]) => [ruleId, { version: "1.0.0", mode }])) as PolicyConfig["rules"];
  return {
    condition: condition.id as EvalConditionTreatment["condition"],
    memoryEnabled: condition.memory === "enabled",
    policyConfig: parsePolicyConfig({ schemaVersion: 1, rules })
  };
}

function parseCondition(value: unknown): EvalConditionProfile {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.runtime !== "string" || typeof value.role !== "string") {
    throw new Error("Malformed Eval condition profile.");
  }
  const ids: EvalConditionId[] = ["pi-native-reference", "actlume-control", "actlume-memory", "actlume-guardrails", "actlume-full"];
  if (!ids.includes(value.id as EvalConditionId)) throw new Error(`Unknown Eval condition '${value.id}'.`);
  if (value.id === "pi-native-reference") {
    if (value.runtime !== "pi-native" || value.role !== "descriptive-reference-only"
      || value.memory !== "native" || value.policies !== null) {
      throw new Error("pi-native-reference must be a separate descriptive reference with native policies/memory.");
    }
    return { id: value.id, runtime: "pi-native", role: value.role, memory: "native", policies: null };
  }
  if (value.runtime !== "actlume" || !isRecord(value.policies) || !["enabled", "disabled"].includes(String(value.memory))) {
    throw new Error(`Actlume condition '${value.id}' must declare a memory toggle and policy modes.`);
  }
  const parsed = parsePolicyConfig({ schemaVersion: 1, rules: Object.fromEntries(
    Object.entries(value.policies).map(([ruleId, mode]) => [ruleId, { version: "1.0.0", mode }])
  ) });
  const policies = Object.fromEntries(Object.entries(parsed.rules).map(([ruleId, definition]) => [ruleId, definition.mode])) as Record<PolicyRuleId, PolicyMode>;
  return { id: value.id as EvalConditionProfile["id"], runtime: "actlume", role: value.role, memory: value.memory as "enabled" | "disabled", policies };
}

function parseComparison(value: unknown): EvalConditionManifest["primaryComparisons"][number] {
  if (!isRecord(value) || typeof value.control !== "string" || typeof value.treatment !== "string" || !Array.isArray(value.changedFactors)) {
    throw new Error("Malformed primary Eval condition comparison.");
  }
  const factors = value.changedFactors.filter((factor): factor is "memory" | "policies" => factor === "memory" || factor === "policies");
  if (factors.length !== value.changedFactors.length || !["actlume-control", "actlume-memory", "actlume-guardrails", "actlume-full"].includes(value.control)
    || !["actlume-control", "actlume-memory", "actlume-guardrails", "actlume-full"].includes(value.treatment)) {
    throw new Error("Primary comparisons may only use executable Actlume conditions and declared factors.");
  }
  return { control: value.control as EvalConditionId, treatment: value.treatment as EvalConditionId, changedFactors: factors };
}

function assertComparison(
  comparisons: EvalConditionManifest["primaryComparisons"], control: EvalConditionId, treatment: EvalConditionId, factors: Array<"memory" | "policies">
): void {
  const found = comparisons.find((item) => item.control === control && item.treatment === treatment);
  if (!found || JSON.stringify(found.changedFactors) !== JSON.stringify(factors)) {
    throw new Error(`Comparison '${control}' -> '${treatment}' must change exactly ${factors.join(" and ")}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
