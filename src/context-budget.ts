export type ContextBudget = {
  maxTokens: number;
  usedTokens: number;
  remainingTokens: number;
};

export type ContextBudgetSource = "model_metadata" | "default_fallback";

export function resolveInjectedContextBudget(contextWindow?: number): { maxTokens: number; source: ContextBudgetSource } {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow < 1) {
    return { maxTokens: 12_000, source: "default_fallback" };
  }
  return { maxTokens: Math.max(256, Math.min(12_000, Math.floor(contextWindow * 0.25))), source: "model_metadata" };
}

export type ContextPack = ContextBudget & {
  text: string;
  sourceChars: number;
  truncated: boolean;
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

/** Keeps project context first, reserves room for selected memories, and truncates only this injected layer. */
export function buildContextPack(projectContext: string, memoryContext: string, maxTokens = 12000): ContextPack {
  const charLimit = Math.max(0, maxTokens * 4);
  const separator = projectContext && memoryContext ? "\n\n" : "";
  const sourceChars = projectContext.length + memoryContext.length + separator.length;
  const memoryLimit = Math.min(memoryContext.length, Math.floor(charLimit * 0.25));
  const boundedMemory = truncateWithEnds(memoryContext, memoryLimit);
  const projectLimit = Math.max(0, charLimit - boundedMemory.length - separator.length);
  const boundedProject = truncateWithEnds(projectContext, projectLimit);
  const text = [boundedProject, boundedMemory].filter(Boolean).join(separator);
  const budget = getContextBudget([text], maxTokens);
  return {
    text,
    sourceChars,
    truncated: text.length < sourceChars,
    ...budget
  };
}

function truncateWithEnds(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  const marker = "\n[Actlume context section truncated to its character budget]\n";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  const available = maxChars - marker.length;
  const headLength = Math.ceil(available * 0.75);
  const tailLength = available - headLength;
  return value.slice(0, headLength) + marker + (tailLength > 0 ? value.slice(-tailLength) : "");
}
