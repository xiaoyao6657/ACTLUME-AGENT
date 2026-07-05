import test from "node:test";
import assert from "node:assert/strict";
import { assembleStreamDeltas } from "./llm.js";

test("assembles streaming deltas into final text", () => {
  assert.equal(assembleStreamDeltas(["{\"type\"", ":\"final\"", "}"]), "{\"type\":\"final\"}");
});
