import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { persistLargeObservation } from "./context-artifacts.js";
import { compactHistoryForPrompt } from "./context-policy.js";
import type { AgentHistoryItem } from "./types.js";

test("persists large observations as artifacts", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "actlume-artifacts-"));
  try {
    const observation = "x".repeat(200);
    const result = await persistLargeObservation({
      memoryDir,
      runId: "run",
      step: 1,
      toolName: "readFile",
      observation,
      maxChars: 50
    });
    assert.ok(result.artifactPath);
    assert.match(result.observation, /\[artifact:/);
    assert.match(result.observation, /Preview:/);
    assert.equal(await readFile(result.artifactPath, "utf8"), observation);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("stale history compression preserves artifact pointers", () => {
  const history: AgentHistoryItem[] = Array.from({ length: 8 }, (_, index) => ({
    thought: `turn ${index}`,
    action: {
      type: "action",
      thought: "read",
      tool: "readFile",
      input: { path: "large.txt" }
    },
    observation: index === 0 ? `[artifact:C:/tmp/large.txt]\n${"x".repeat(3000)}` : "ok"
  }));

  const compacted = compactHistoryForPrompt(history, 1);
  assert.match(compacted[0]?.observation ?? "", /\[artifact:/);
  assert.match(compacted[0]?.observation ?? "", /stale observation snipped/);
});
