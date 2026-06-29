export type ContextBudget = {
  maxTokens: number;
  usedTokens: number;
  remainingTokens: number;
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function getContextBudget(parts: string[], maxTokens = 12000): ContextBudget {
  const usedTokens = estimateTokens(parts.join("\n"));
  return {
    maxTokens,
    usedTokens,
    remainingTokens: Math.max(0, maxTokens - usedTokens)
  };
}
