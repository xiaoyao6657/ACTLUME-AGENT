import type { AgentHistoryItem } from "./types.js";
import { getContextBudget } from "./context-budget.js";
import { summarizeObservation } from "./summary.js";

const intactWindow = 6;
const largeObsThreshold = 3000;

export function compactHistoryForPrompt(history: AgentHistoryItem[], maxTokens = 8000): AgentHistoryItem[] {
  const parts = history.map((item) => `${item.thought}\n${item.observation}`);
  const budget = getContextBudget(parts, maxTokens);

  if (history.length <= intactWindow && budget.remainingTokens > 1000) {
    return history;
  }

  return history.map((item, index) => {
    const stale = index < history.length - intactWindow;
    const oversized = item.observation.length > largeObsThreshold;
    if (!stale && !oversized) {
      return item;
    }

    return {
      ...item,
      observation: stale
        ? snipStaleObservation(item.observation)
        : summarizeObservation(item.observation)
    };
  });
}

function snipStaleObservation(observation: string): string {
  const facts = extractKeyFacts(observation);
  const artifact = observation.match(/\[artifact:[^\]]+\]/)?.[0];
  const pointer = observation.match(/\[pointer:[^\]]+\]/)?.[0];
  const prefix = artifact ?? pointer;
  const summary = summarizeObservation(observation);

  const parts = [
    prefix ?? "",
    "[stale observation snipped]",
    facts,
    summary
  ].filter(Boolean);

  return parts.join("\n");
}

function extractKeyFacts(observation: string): string {
  const lines = observation.split(/\r?\n/);
  const facts: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 200) {
      continue;
    }

    if (
      trimmed.startsWith("code:") ||
      trimmed.includes("[tool_error]") ||
      trimmed.includes("exitCode") ||
      trimmed.startsWith("[artifact:") ||
      trimmed.match(/^\s*(?:ok|retryable|status|steps):/)
    ) {
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        facts.push(trimmed);
      }
      continue;
    }

    const pathMatch = trimmed.match(/(?:^|\s)(\.?\/?[\w./-]+\.[\w]{1,6})(?::\d+)?(?:\s|$)/);
    if (pathMatch && !seen.has(trimmed)) {
      seen.add(trimmed);
      facts.push(trimmed);
    }
  }

  return facts.length > 0 ? `Key facts:\n${facts.slice(0, 10).join("\n")}` : "";
}
