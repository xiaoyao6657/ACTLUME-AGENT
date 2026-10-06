export async function evaluate(_workspace, evidence = {}) {
  const expected = "INC-48271 · cache invalidation skipped after config reload";
  const observed = Array.isArray(evidence.artifactToolResults) ? evidence.artifactToolResults.join("\n") : "";
  const answer = typeof evidence.finalAnswer === "string" ? evidence.finalAnswer : "";
  if (!evidence.artifactRetrieved || !observed || !answer) {
    return { verdict: "unknown", reason: "artifact execution evidence and final answer are required" };
  }
  if (!observed.includes(expected) || !answer.includes("INC-48271") || !answer.includes("after config reload")) {
    return { verdict: "fail", reason: "requested sentinel or surrounding condition was not recovered" };
  }
  return { verdict: "pass", checks: 3 };
}

export async function calibrate() {
  const expected = "INC-48271 · cache invalidation skipped after config reload";
  return { artifactRetrieved: true, artifactToolResults: [expected], finalAnswer: expected };
}
