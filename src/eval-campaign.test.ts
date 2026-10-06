import test from "node:test";
import assert from "node:assert/strict";
import { assertCampaignTaskSuite, decideCampaignAttempt } from "./eval-campaign.js";

const budget = {
  attemptsStarted: 0,
  maxAttempts: 4,
  cumulativeReportedTokens: 0,
  usageKnown: true,
  maxTotalReportedTokens: 80_000,
  maxReportedTokensPerAttempt: 20_000
};

test("campaign starts another attempt only when a complete per-attempt reserve remains", () => {
  assert.deepEqual(decideCampaignAttempt({ ...budget, cumulativeReportedTokens: 59_999 }), { start: true });
  assert.deepEqual(decideCampaignAttempt({ ...budget, cumulativeReportedTokens: 60_001 }), { start: false, reason: "token-budget-reserve" });
});

test("campaign preserves unknown usage and attempt ceilings as hard stops", () => {
  assert.deepEqual(decideCampaignAttempt({ ...budget, usageKnown: false }), { start: false, reason: "usage-unknown" });
  assert.deepEqual(decideCampaignAttempt({ ...budget, attemptsStarted: 4 }), { start: false, reason: "attempt-limit" });
});

test("development and holdout cards cannot be mixed into the wrong frozen suite", () => {
  assert.doesNotThrow(() => assertCampaignTaskSuite("holdout-parser-boundary-01", "holdout"));
  assert.doesNotThrow(() => assertCampaignTaskSuite("memory-transfer-01", "development"));
  assert.throws(() => assertCampaignTaskSuite("holdout-honesty-01", "development"), /belongs to the holdout suite/);
  assert.throws(() => assertCampaignTaskSuite("short-regression-01", "holdout"), /belongs to the development suite/);
});
