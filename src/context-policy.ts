import type { AgentHistoryItem } from "./types.js";
import { getContextBudget } from "./context-budget.js";
import { summarizeObservation } from "./summary.js";

export function compactHistoryForPrompt(history: AgentHistoryItem[], maxTokens = 12000): AgentHistoryItem[] {
  const parts = history.map((item) => `${item.thought}\n${item.observation}`);
  const budget = getContextBudget(parts, maxTokens);

  if (budget.remainingTokens > 1000) {
    return history;
  }

  return history.map((item, index) => {
    const shouldCompress = index < history.length - 2 || item.observation.length > 2000;
    if (!shouldCompress) {
      return item;
    }

    return {
      ...item,
      observation: summarizeObservation(item.observation)
    };
  });
}
