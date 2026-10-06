export type CampaignBudgetDecision =
  | { start: true }
  | { start: false; reason: "attempt-limit" | "usage-unknown" | "token-budget-reserve" };

export type CampaignSuite = "development" | "holdout";

export function assertCampaignTaskSuite(taskId: string, suite: CampaignSuite): void {
  const taskSuite = taskId.startsWith("holdout-") ? "holdout" : "development";
  if (taskSuite !== suite) throw new Error(`Task '${taskId}' belongs to the ${taskSuite} suite; freeze this manifest with --suite ${taskSuite}.`);
}

export function decideCampaignAttempt(input: {
  attemptsStarted: number;
  maxAttempts: number;
  cumulativeReportedTokens: number;
  usageKnown: boolean;
  maxTotalReportedTokens: number;
  maxReportedTokensPerAttempt: number;
}): CampaignBudgetDecision {
  if (input.attemptsStarted >= input.maxAttempts) return { start: false, reason: "attempt-limit" };
  if (!input.usageKnown) return { start: false, reason: "usage-unknown" };
  const remaining = input.maxTotalReportedTokens - input.cumulativeReportedTokens;
  if (remaining < input.maxReportedTokensPerAttempt) return { start: false, reason: "token-budget-reserve" };
  return { start: true };
}
