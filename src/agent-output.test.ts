import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentOutput } from "./agent.js";

test("repairs mixed text plus JSON agent output", () => {
  const parsed = parseAgentOutput('Here is the action: {"type":"final","answer":"done"}');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.type, "final");
    assert.equal(parsed.value.answer, "done");
  }
});

test("rejects invalid agent output", () => {
  const parsed = parseAgentOutput("not json");
  assert.equal(parsed.ok, false);
});
