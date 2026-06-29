import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseLlmError, extractAssistantText, inferModelProfile } from "./model-adapter.js";

test("infers DeepSeek model profile and reasoning fallback", () => {
  const profile = inferModelProfile({ model: "deepseek-v4-pro", baseURL: "https://api.deepseek.com" });
  assert.equal(profile.provider, "deepseek");
  assert.equal(profile.supportsReasoningContent, true);
  assert.equal(extractAssistantText({ reasoning_content: "reasoned answer" }, profile), "reasoned answer");
});

test("diagnoses HTML gateway responses", () => {
  const message = diagnoseLlmError(new Error("<!doctype html><html></html>"), {
    model: "x",
    baseURL: "http://example.local"
  });
  assert.match(message, /HTML page/);
  assert.match(message, /Base URL/);
});

test("diagnoses authentication failures", () => {
  const error = Object.assign(new Error("401 Authentication Fails"), { status: 401 });
  const message = diagnoseLlmError(error, { model: "x", baseURL: "https://api.example/v1" });
  assert.match(message, /API key/);
});
