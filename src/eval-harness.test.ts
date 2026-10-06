import test from "node:test";
import assert from "node:assert/strict";
import { parseEvalJsonl, summarizeEvaluations, toEvalJsonl, type EvalRunRecord } from "./eval-harness.js";

function record(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    schemaVersion: 2,
    pairingControls: {
      fixtureHash: "fixture-v1",
      candidateHash: "candidate-commit",
      providerId: "fixture-provider",
      sampling: { temperature: 0, topP: 1, seed: 7 },
      permissionMode: "plan",
      toolsetHash: "toolset-v1",
      budget: { maxSteps: 30, maxDurationMs: 300_000, maxTokens: 8_000 },
      interruptionProtocol: "none"
    },
    runId: "run-1",
    taskId: "task-1",
    repeatIndex: 0,
    condition: "pi-default",
    category: "short-task",
    modelId: "fixture-model",
    modelRevision: "fixture-rev-1",
    repositoryCommit: "0123456789abcdef",
    environmentId: "node-24-windows",
    promptHash: "sha256:prompt",
    independentVerdict: "pass",
    agentClaimedComplete: true,
    runtimeStatus: "completed",
    modelRequests: 2,
    requestedToolCalls: 3,
    executedToolCalls: 3,
    blockedToolCalls: 0,
    humanInterventions: 0,
    inputTokens: 20,
    outputTokens: 10,
    durationMs: 1_000,
    ...overrides
  };
}

test("Eval report separates independent outcomes, unknown usage, and paired results", () => {
  const records = [
    record({
      condition: "pi-default",
      independentVerdict: "fail",
      staleMemoryExposed: true,
      staleMemoryMisused: true,
      failureClass: "wrong-change"
    }),
    record({ runId: "run-2", repeatIndex: 1 }),
    record({
      runId: "run-3",
      condition: "actlume-full",
      independentVerdict: "pass",
      interruptionInjected: true,
      resumed: true,
      inputTokens: undefined,
      outputTokens: undefined
    }),
    record({
      runId: "run-5",
      repeatIndex: 1,
      condition: "actlume-full",
      independentVerdict: "pass",
      inputTokens: undefined,
      outputTokens: undefined
    }),
    record({
      runId: "run-4",
      taskId: "task-2",
      repeatIndex: 1,
      condition: "actlume-full",
      independentVerdict: "unknown",
      agentClaimedComplete: false,
      inputTokens: undefined,
      outputTokens: undefined
    })
  ];

  const parsed = parseEvalJsonl(toEvalJsonl(records));
  assert.equal(parsed.length, records.length);
  const report = summarizeEvaluations(parsed, [{ baseline: "pi-default", candidate: "actlume-full" }]);
  const baseline = report.conditions.find((item) => item.condition === "pi-default");
  const candidate = report.conditions.find((item) => item.condition === "actlume-full");
  assert.equal(baseline?.resolveRate, 0.5);
  assert.equal(baseline?.falseCompletionClaims, 1);
  assert.equal(baseline?.staleMemoryMisuseRate, 1);
  assert.equal(candidate?.resolveRate, 1);
  assert.equal(candidate?.recoveryRate, 1);
  assert.equal(candidate?.knownUsageRuns, 0);
  assert.equal(candidate?.inputTokens, null);
  assert.equal(candidate?.unknownVerdict, 1);
  assert.deepEqual(report.comparisons[0], {
    baseline: "pi-default",
    candidate: "actlume-full",
    paired: 2,
    excludedControlMismatches: 0,
    excludedUnknownControls: 0,
    candidateWins: 1,
    baselineWins: 0,
    ties: 1,
    resolveRateDelta: 0.5
  });
});

test("Eval parser rejects malformed and unsupported records with line numbers", () => {
  assert.throws(() => parseEvalJsonl(`${JSON.stringify(record())}\nnot-json`), /line 2/);
  assert.throws(() => parseEvalJsonl("{}"), /line 1.*supported schema version/);
});

test("paired Eval comparisons exclude attempts with mismatched controls", () => {
  const report = summarizeEvaluations([
    record({ condition: "pi-default" }),
    record({ condition: "actlume-full", runId: "run-b", modelRevision: "different-model-revision" })
  ], [{ baseline: "pi-default", candidate: "actlume-full" }]);

  assert.equal(report.comparisons[0]?.paired, 0);
  assert.equal(report.comparisons[0]?.excludedControlMismatches, 1);
  assert.equal(report.comparisons[0]?.excludedUnknownControls, 0);
  assert.equal(report.comparisons[0]?.resolveRateDelta, null);
});

test("paired Eval rejects unknown controls but does not treat a treatment context hash as a task mismatch", () => {
  const unknown = summarizeEvaluations([
    record({ condition: "pi-default", modelRevision: "unknown" }),
    record({ condition: "actlume-full", runId: "run-b", modelRevision: "unknown" })
  ], [{ baseline: "pi-default", candidate: "actlume-full" }]).comparisons[0];
  assert.equal(unknown?.paired, 0);
  assert.equal(unknown?.excludedUnknownControls, 1);

  const treatment = summarizeEvaluations([
    record({ condition: "actlume-control", systemContextHash: "context-control", treatmentConfigHash: "treatment-none" }),
    record({ condition: "actlume-memory", runId: "run-b", systemContextHash: "context-memory", treatmentConfigHash: "memory-v1" })
  ], [{ baseline: "actlume-control", candidate: "actlume-memory" }]).comparisons[0];
  assert.equal(treatment?.paired, 1);
  assert.equal(treatment?.excludedControlMismatches, 0);
});

test("paired Eval refuses every declared control mismatch", () => {
  const mismatches: Array<[string, (value: EvalRunRecord) => EvalRunRecord]> = [
    ["fixtureHash", (value) => ({ ...value, pairingControls: { ...value.pairingControls!, fixtureHash: "other-fixture" } })],
    ["candidateHash", (value) => ({ ...value, pairingControls: { ...value.pairingControls!, candidateHash: "other-candidate" } })],
    ["providerId", (value) => ({ ...value, pairingControls: { ...value.pairingControls!, providerId: "other-provider" } })],
    ["temperature", (value) => ({ ...value, pairingControls: { ...value.pairingControls!, sampling: { ...value.pairingControls!.sampling, temperature: 0.2 } } })],
    ["seed", (value) => ({ ...value, pairingControls: { ...value.pairingControls!, sampling: { ...value.pairingControls!.sampling, seed: 99 } } })],
    ["permissions", (value) => ({ ...value, pairingControls: { ...value.pairingControls!, permissionMode: "default" } })],
    ["toolset", (value) => ({ ...value, pairingControls: { ...value.pairingControls!, toolsetHash: "other-tools" } })],
    ["environment", (value) => ({ ...value, environmentId: "other-env" })],
    ["budget", (value) => ({ ...value, pairingControls: { ...value.pairingControls!, budget: { ...value.pairingControls!.budget, maxSteps: 31 } } })],
    ["interruption", (value) => ({ ...value, pairingControls: { ...value.pairingControls!, interruptionProtocol: "kill-after-edit" } })],
    ["prompt", (value) => ({ ...value, promptHash: "sha256:different-input" })],
    ["category", (value) => ({ ...value, category: "long-context" })]
  ];
  for (const [name, mutate] of mismatches) {
    const candidate = mutate(record({ condition: "actlume-full", runId: `mismatch-${name}` }));
    const comparison = summarizeEvaluations([
      record({ condition: "pi-default" }), candidate
    ], [{ baseline: "pi-default", candidate: "actlume-full" }]).comparisons[0];
    assert.equal(comparison?.paired, 0, `${name} mismatch must prevent a pair`);
    assert.equal(comparison?.excludedControlMismatches, 1, `${name} mismatch must be counted`);
  }
});

test("Eval reports judged and conservative denominators for claims, recovery, and stale-memory misuse", () => {
  const summary = summarizeEvaluations([
    record({ runId: "claim-fail", independentVerdict: "fail", completionClaimStatus: "claimed_complete", agentClaimedComplete: true }),
    record({ runId: "claim-unknown", independentVerdict: "unknown", completionClaimStatus: "claimed_complete", agentClaimedComplete: true }),
    record({ runId: "claim-ambiguous", independentVerdict: "unknown", completionClaimStatus: "unknown", agentClaimedComplete: false }),
    record({ runId: "recovery-pass", agentClaimedComplete: false, completionClaimStatus: "not_claimed", interruptionInjected: true, resumed: true, independentVerdict: "pass" }),
    record({ runId: "recovery-unknown", agentClaimedComplete: false, completionClaimStatus: "not_claimed", interruptionInjected: true, resumed: undefined, independentVerdict: "unknown" }),
    record({ runId: "memory-judged", agentClaimedComplete: false, completionClaimStatus: "not_claimed", staleMemoryExposed: true, staleMemoryMisused: false }),
    record({ runId: "memory-unknown", agentClaimedComplete: false, completionClaimStatus: "not_claimed", staleMemoryExposed: true, staleMemoryMisused: undefined, independentVerdict: "unknown" })
  ]).conditions[0];

  assert.equal(summary?.completionClaims, 2);
  assert.equal(summary?.judgedCompletionClaims, 1);
  assert.equal(summary?.unknownVerdictCompletionClaims, 1);
  assert.equal(summary?.ambiguousCompletionClaims, 1);
  assert.equal(summary?.falseCompletionRate, 1);
  assert.equal(summary?.falseCompletionRateConservative, 1);
  assert.equal(summary?.recoveryJudged, 1);
  assert.equal(summary?.recoveryUnknown, 1);
  assert.equal(summary?.recoveryRate, 1);
  assert.equal(summary?.recoveryRateConservative, 0.5);
  assert.equal(summary?.staleMemoryExposureJudged, 1);
  assert.equal(summary?.staleMemoryExposureUnknown, 1);
  assert.equal(summary?.staleMemoryMisuseRate, 0);
  assert.equal(summary?.staleMemoryMisuseRateConservative, 0.5);
});
