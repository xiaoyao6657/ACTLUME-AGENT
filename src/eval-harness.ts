export type EvalCondition = "pi-default" | "actlume-memory" | "actlume-guardrails" | "actlume-full" | string;

export type EvalPairingControls = {
  fixtureHash: string;
  candidateHash: string;
  providerId: string;
  sampling: { temperature: number | null; topP: number | null; seed: number | "unsupported" | "unknown" };
  permissionMode: string;
  toolsetHash: string;
  budget: { maxSteps: number; maxDurationMs: number; maxTokens: number | null };
  interruptionProtocol: string;
};

export type EvalRunRecord = {
  schemaVersion: 1 | 2;
  pairingControls?: EvalPairingControls;
  runId: string;
  taskId: string;
  repeatIndex: number;
  condition: EvalCondition;
  category: "short-task" | "long-context" | "memory-transfer" | "requirement-change" | "interruption-recovery" | "other";
  modelId: string;
  modelRevision: string;
  systemContextHash?: string;
  treatmentConfigHash?: string;
  repositoryCommit: string;
  environmentId: string;
  promptHash: string;
  independentVerdict?: "pass" | "fail" | "unknown";
  agentClaimedComplete: boolean;
  completionClaimStatus?: "claimed_complete" | "not_claimed" | "unknown";
  runtimeStatus: "completed" | "failed" | "cancelled" | "interrupted" | "budget_exhausted" | "unknown";
  interruptionInjected?: boolean;
  resumed?: boolean;
  staleMemoryExposed?: boolean;
  staleMemoryMisused?: boolean;
  modelRequests: number;
  requestedToolCalls: number;
  executedToolCalls: number;
  blockedToolCalls: number;
  humanInterventions: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  failureClass?: string;
  tracePath?: string;
};

export type EvalConditionSummary = {
  condition: EvalCondition;
  attempted: number;
  judged: number;
  passed: number;
  failed: number;
  unknownVerdict: number;
  resolveRate: number | null;
  falseCompletionClaims: number;
  completionClaims: number;
  judgedCompletionClaims: number;
  unknownVerdictCompletionClaims: number;
  ambiguousCompletionClaims: number;
  falseCompletionRate: number | null;
  falseCompletionRateConservative: number | null;
  interruptions: number;
  recoveryJudged: number;
  recoveryUnknown: number;
  recovered: number;
  recoveryRate: number | null;
  recoveryRateConservative: number | null;
  staleMemoryExposures: number;
  staleMemoryExposureJudged: number;
  staleMemoryExposureUnknown: number;
  staleMemoryMisuses: number;
  staleMemoryMisuseRate: number | null;
  staleMemoryMisuseRateConservative: number | null;
  knownUsageRuns: number;
  inputTokens: number | null;
  outputTokens: number | null;
  meanDurationMs: number | null;
  failuresByClass: Record<string, number>;
};

export type PairedConditionComparison = {
  baseline: EvalCondition;
  candidate: EvalCondition;
  paired: number;
  excludedControlMismatches: number;
  excludedUnknownControls: number;
  candidateWins: number;
  baselineWins: number;
  ties: number;
  resolveRateDelta: number | null;
};

export type EvalReport = {
  schemaVersion: 1;
  generatedAt: string;
  records: number;
  conditions: EvalConditionSummary[];
  comparisons: PairedConditionComparison[];
};

export function parseEvalJsonl(raw: string): EvalRunRecord[] {
  return raw.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid Eval JSON on line ${index + 1}.`);
    }
    if (!isEvalRunRecord(value)) throw new Error(`Eval record on line ${index + 1} does not match a supported schema version.`);
    return [value];
  });
}

export function summarizeEvaluations(
  records: EvalRunRecord[],
  comparisons: Array<{ baseline: EvalCondition; candidate: EvalCondition }> = []
): EvalReport {
  const byCondition = new Map<EvalCondition, EvalRunRecord[]>();
  for (const record of records) {
    const bucket = byCondition.get(record.condition) ?? [];
    bucket.push(record);
    byCondition.set(record.condition, bucket);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    records: records.length,
    conditions: [...byCondition.entries()].map(([condition, items]) => summarizeCondition(condition, items)),
    comparisons: comparisons.map(({ baseline, candidate }) => compareConditions(records, baseline, candidate))
  };
}

export function toEvalJsonl(records: EvalRunRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

function summarizeCondition(condition: EvalCondition, records: EvalRunRecord[]): EvalConditionSummary {
  const judged = records.filter((record) => record.independentVerdict === "pass" || record.independentVerdict === "fail");
  const passed = judged.filter((record) => record.independentVerdict === "pass").length;
  const falseCompletionClaims = records.filter((record) => record.agentClaimedComplete && record.independentVerdict === "fail").length;
  const completionClaims = records.filter(isClaimedComplete).length;
  const judgedCompletionClaims = records.filter((record) => isClaimedComplete(record)
    && (record.independentVerdict === "pass" || record.independentVerdict === "fail")).length;
  const unknownVerdictCompletionClaims = records.filter((record) => isClaimedComplete(record)
    && (record.independentVerdict === "unknown" || record.independentVerdict === undefined)).length;
  const ambiguousCompletionClaims = records.filter((record) => record.completionClaimStatus === "unknown").length;
  const interruptionRecords = records.filter((record) => record.interruptionInjected === true);
  const recoveryJudged = interruptionRecords.filter((record) => record.independentVerdict === "pass" || record.independentVerdict === "fail").length;
  const recoveryUnknown = interruptionRecords.length - recoveryJudged;
  const recovered = interruptionRecords.filter((record) => record.resumed === true && record.independentVerdict === "pass").length;
  const staleMemoryExposures = records.filter((record) => record.staleMemoryExposed === true).length;
  const staleMemoryExposureJudged = records.filter((record) => record.staleMemoryExposed === true && typeof record.staleMemoryMisused === "boolean").length;
  const staleMemoryExposureUnknown = staleMemoryExposures - staleMemoryExposureJudged;
  const staleMemoryMisuses = records.filter((record) => record.staleMemoryExposed === true && record.staleMemoryMisused === true).length;
  const knownUsage = records.filter((record) => record.inputTokens !== undefined && record.outputTokens !== undefined);
  const failuresByClass: Record<string, number> = {};
  for (const record of records) {
    if (record.independentVerdict === "fail" || record.runtimeStatus !== "completed") {
      const failureClass = record.failureClass ?? (record.runtimeStatus !== "completed" ? record.runtimeStatus : "unclassified");
      failuresByClass[failureClass] = (failuresByClass[failureClass] ?? 0) + 1;
    }
  }
  return {
    condition,
    attempted: records.length,
    judged: judged.length,
    passed,
    failed: judged.length - passed,
    unknownVerdict: records.length - judged.length,
    resolveRate: ratio(passed, judged.length),
    falseCompletionClaims,
    completionClaims,
    judgedCompletionClaims,
    unknownVerdictCompletionClaims,
    ambiguousCompletionClaims,
    falseCompletionRate: ratio(falseCompletionClaims, judgedCompletionClaims),
    falseCompletionRateConservative: ratio(falseCompletionClaims + unknownVerdictCompletionClaims, completionClaims),
    interruptions: interruptionRecords.length,
    recoveryJudged,
    recoveryUnknown,
    recovered,
    recoveryRate: ratio(recovered, recoveryJudged),
    recoveryRateConservative: ratio(recovered, interruptionRecords.length),
    staleMemoryExposures,
    staleMemoryExposureJudged,
    staleMemoryExposureUnknown,
    staleMemoryMisuses,
    staleMemoryMisuseRate: ratio(staleMemoryMisuses, staleMemoryExposureJudged),
    staleMemoryMisuseRateConservative: ratio(staleMemoryMisuses + staleMemoryExposureUnknown, staleMemoryExposures),
    knownUsageRuns: knownUsage.length,
    inputTokens: knownUsage.length ? sum(knownUsage.map((record) => record.inputTokens ?? 0)) : null,
    outputTokens: knownUsage.length ? sum(knownUsage.map((record) => record.outputTokens ?? 0)) : null,
    meanDurationMs: records.length ? sum(records.map((record) => record.durationMs)) / records.length : null,
    failuresByClass
  };
}

function compareConditions(records: EvalRunRecord[], baseline: EvalCondition, candidate: EvalCondition): PairedConditionComparison {
  const byKey = new Map<string, Map<EvalCondition, EvalRunRecord>>();
  for (const record of records) {
    const key = `${record.taskId}\0${record.repeatIndex}`;
    const pair = byKey.get(key) ?? new Map<EvalCondition, EvalRunRecord>();
    if (pair.has(record.condition)) throw new Error(`Duplicate Eval record for task '${record.taskId}', repeat ${record.repeatIndex}, condition '${record.condition}'.`);
    pair.set(record.condition, record);
    byKey.set(key, pair);
  }
  let paired = 0;
  let candidateWins = 0;
  let baselineWins = 0;
  let ties = 0;
  let excludedControlMismatches = 0;
  let excludedUnknownControls = 0;
  let baselinePassed = 0;
  let candidatePassed = 0;
  for (const pair of byKey.values()) {
    const baseRecord = pair.get(baseline);
    const candidateRecord = pair.get(candidate);
    if (baseRecord && candidateRecord) {
      const mismatch = pairingControlMismatch(baseRecord, candidateRecord);
      if (mismatch === "unknown") { excludedUnknownControls += 1; continue; }
      if (mismatch) { excludedControlMismatches += 1; continue; }
    }
    if (!baseRecord || !candidateRecord
      || (baseRecord.independentVerdict !== "pass" && baseRecord.independentVerdict !== "fail")
      || (candidateRecord.independentVerdict !== "pass" && candidateRecord.independentVerdict !== "fail")) continue;
    paired += 1;
    if (baseRecord.independentVerdict === "pass") baselinePassed += 1;
    if (candidateRecord.independentVerdict === "pass") candidatePassed += 1;
    if (baseRecord.independentVerdict === candidateRecord.independentVerdict) ties += 1;
    else if (candidateRecord.independentVerdict === "pass") candidateWins += 1;
    else baselineWins += 1;
  }
  return {
    baseline,
    candidate,
    paired,
    excludedControlMismatches,
    excludedUnknownControls,
    candidateWins,
    baselineWins,
    ties,
    resolveRateDelta: paired === 0 ? null : (candidatePassed - baselinePassed) / paired
  };
}

function pairingControlMismatch(left: EvalRunRecord, right: EvalRunRecord): "unknown" | "mismatch" | undefined {
  const leftControls = left.pairingControls;
  const rightControls = right.pairingControls;
  if (left.schemaVersion !== 2 || right.schemaVersion !== 2 || !leftControls || !rightControls
    || isUnknown(left.modelRevision) || isUnknown(right.modelRevision)
    || isUnknown(left.repositoryCommit) || isUnknown(right.repositoryCommit)
    || isUnknown(left.environmentId) || isUnknown(right.environmentId)
    || isUnknown(left.promptHash) || isUnknown(right.promptHash)
    || isUnknown(leftControls.fixtureHash) || isUnknown(rightControls.fixtureHash)
    || isUnknown(leftControls.candidateHash) || isUnknown(rightControls.candidateHash)
    || isUnknown(leftControls.providerId) || isUnknown(rightControls.providerId)
    || isUnknown(leftControls.toolsetHash) || isUnknown(rightControls.toolsetHash)
    || isUnknown(leftControls.permissionMode) || isUnknown(rightControls.permissionMode)
    || isUnknown(leftControls.interruptionProtocol) || isUnknown(rightControls.interruptionProtocol)
    || leftControls.sampling.temperature === null || rightControls.sampling.temperature === null
    || leftControls.sampling.topP === null || rightControls.sampling.topP === null
    || leftControls.sampling.seed === "unknown" || rightControls.sampling.seed === "unknown"
    || leftControls.budget.maxTokens === null || rightControls.budget.maxTokens === null) return "unknown";
  const controlsMatch = JSON.stringify([
    left.category, left.modelId, left.modelRevision, left.repositoryCommit, left.environmentId, left.promptHash,
    leftControls.fixtureHash, leftControls.candidateHash, leftControls.providerId,
    leftControls.sampling, leftControls.permissionMode, leftControls.toolsetHash,
    leftControls.budget, leftControls.interruptionProtocol
  ]) === JSON.stringify([
    right.category, right.modelId, right.modelRevision, right.repositoryCommit, right.environmentId, right.promptHash,
    rightControls.fixtureHash, rightControls.candidateHash, rightControls.providerId,
    rightControls.sampling, rightControls.permissionMode, rightControls.toolsetHash,
    rightControls.budget, rightControls.interruptionProtocol
  ]);
  return controlsMatch ? undefined : "mismatch";
}

function isEvalRunRecord(value: unknown): value is EvalRunRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<EvalRunRecord>;
  const numericFields = [
    record.modelRequests,
    record.requestedToolCalls,
    record.executedToolCalls,
    record.blockedToolCalls,
    record.humanInterventions,
    record.durationMs
  ];
  const validOptionalNumber = (value: number | undefined) => value === undefined || (Number.isFinite(value) && value >= 0);
  const validBase = (record.schemaVersion === 1 || record.schemaVersion === 2)
    && typeof record.runId === "string"
    && record.runId.length > 0
    && typeof record.taskId === "string"
    && record.taskId.length > 0
    && Number.isInteger(record.repeatIndex) && (record.repeatIndex ?? -1) >= 0
    && typeof record.condition === "string"
    && record.condition.length > 0
    && ["short-task", "long-context", "memory-transfer", "requirement-change", "interruption-recovery", "other"].includes(record.category ?? "")
    && typeof record.modelId === "string"
    && typeof record.modelRevision === "string"
    && [undefined, record.systemContextHash, record.treatmentConfigHash].every((value) => value === undefined || typeof value === "string")
    && typeof record.repositoryCommit === "string"
    && typeof record.environmentId === "string"
    && typeof record.promptHash === "string"
    && typeof record.agentClaimedComplete === "boolean"
    && [undefined, "claimed_complete", "not_claimed", "unknown"].includes(record.completionClaimStatus)
    && ["completed", "failed", "cancelled", "interrupted", "budget_exhausted", "unknown"].includes(record.runtimeStatus ?? "")
    && [undefined, "pass", "fail", "unknown"].includes(record.independentVerdict)
    && numericFields.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    && numericFields.slice(0, 5).every((value) => Number.isInteger(value))
    && validOptionalNumber(record.inputTokens)
    && validOptionalNumber(record.outputTokens)
    && [record.interruptionInjected, record.resumed, record.staleMemoryExposed, record.staleMemoryMisused]
      .every((value) => value === undefined || typeof value === "boolean");
  if (!validBase) return false;
  if (record.schemaVersion === 1) return record.pairingControls === undefined;
  const controls = record.pairingControls as unknown;
  if (!isRecord(controls) || !isRecord(controls.sampling) || !isRecord(controls.budget)) return false;
  const sampling = controls.sampling;
  const budget = controls.budget;
  const nullableFinite = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));
  return typeof controls.fixtureHash === "string" && typeof controls.candidateHash === "string"
    && typeof controls.providerId === "string" && typeof controls.permissionMode === "string"
    && typeof controls.toolsetHash === "string" && typeof controls.interruptionProtocol === "string"
    && nullableFinite(sampling.temperature) && nullableFinite(sampling.topP)
    && (typeof sampling.seed === "number" || ["unsupported", "unknown"].includes(String(sampling.seed)))
    && Number.isInteger(budget.maxSteps) && Number(budget.maxSteps) > 0
    && typeof budget.maxDurationMs === "number" && Number.isFinite(budget.maxDurationMs) && budget.maxDurationMs > 0
    && (budget.maxTokens === null || (Number.isInteger(budget.maxTokens) && Number(budget.maxTokens) > 0));
}

function isClaimedComplete(record: EvalRunRecord): boolean {
  return record.completionClaimStatus === "claimed_complete"
    || (record.completionClaimStatus === undefined && record.agentClaimedComplete);
}

function isUnknown(value: string | undefined): boolean {
  return !value || value.trim().toLowerCase() === "unknown" || value.trim().toLowerCase() === "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
