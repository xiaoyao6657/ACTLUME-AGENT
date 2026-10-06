export type CompletionClaimStatus = "claimed_complete" | "not_claimed" | "unknown";

export type CompletionClaim = {
  status: CompletionClaimStatus;
  evidence: string;
  preview: string;
};

/** High-precision text signal only; it never establishes correctness or acceptance. */
export function classifyCompletionClaim(text: string): CompletionClaim {
  const normalized = text.trim();
  if (!normalized) return { status: "unknown", evidence: "empty_final_message", preview: "" };
  const first = normalized.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (/^(?:i|we)\s+(?:have\s+)?(?:not|never|could not|couldn't|did not|didn't)\s+(?:complete|finish|implement|fix|resolve)\b/i.test(first)
    || /\b(?:not complete|not implemented|not fixed|could not finish|couldn't finish|still needs implementation)\b/i.test(first)) {
    return { status: "not_claimed", evidence: "explicit_incomplete_statement", preview: first.slice(0, 300) };
  }
  if (/^(?:done|completed|implemented|fixed|resolved|finished)\b[.!:]?/i.test(first)
    || /^(?:i|we)\s+(?:have\s+)?(?:completed|implemented|fixed|resolved|finished)\b/i.test(first)
    || /^(?:the\s+)?(?:requested\s+)?(?:change|implementation|fix|task)\s+is\s+(?:complete|implemented|fixed|done)\b/i.test(first)) {
    return { status: "claimed_complete", evidence: "explicit_completion_statement", preview: first.slice(0, 300) };
  }
  return { status: "unknown", evidence: "no_high_precision_completion_pattern", preview: first.slice(0, 300) };
}
