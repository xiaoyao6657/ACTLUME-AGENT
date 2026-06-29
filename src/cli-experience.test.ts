import test from "node:test";
import assert from "node:assert/strict";
import { consumeMultilineInput, emptyMultilineState, highlightDiff, renderMarkdown } from "./cli-experience.js";

test("combines multiline input with trailing backslash", () => {
  const state = emptyMultilineState();
  assert.equal(consumeMultilineInput(state, "line one\\").ready, false);
  const result = consumeMultilineInput(state, "line two");
  assert.deepEqual(result, { ready: true, text: "line one\nline two", prompt: "\nactlume> " });
});

test("render helpers preserve text content", () => {
  assert.match(renderMarkdown("# Title\n- item"), /Title/);
  assert.match(highlightDiff("+added\n-removed"), /added/);
});
