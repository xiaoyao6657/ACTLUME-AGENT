import test from "node:test";
import assert from "node:assert/strict";
import { classifyCompletionClaim } from "./completion-claim.js";

test("completion claim classifier records only high-precision declarations", () => {
  assert.equal(classifyCompletionClaim("Implemented the parser fix. Tests pass.").status, "claimed_complete");
  assert.equal(classifyCompletionClaim("I could not finish the requested change.").status, "not_claimed");
  assert.equal(classifyCompletionClaim("The test command failed; I cannot confirm the fix.").status, "unknown");
  assert.equal(classifyCompletionClaim("").status, "unknown");
});
