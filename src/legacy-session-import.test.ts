import assert from "node:assert/strict";
import test from "node:test";
import { formatLegacySessionImport, formatLegacySessionList } from "./legacy-session-import.js";
import type { SessionSnapshot } from "./session.js";

const snapshot: SessionSnapshot = {
  metadata: {
    id: "legacy-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    userTask: "Fix an old bug",
    status: "completed"
  },
  history: [{
    thought: "Inspect the parser",
    action: { type: "action", thought: "Read parser", tool: "readFile", input: { path: "src/parser.ts" } },
    observation: "Historical parser content"
  }],
  answer: "Historical result",
  updatedAt: "2026-01-01T00:01:00.000Z"
};

test("legacy session import preserves provenance and does not describe old calls as current executions", () => {
  const imported = formatLegacySessionImport(snapshot);
  assert.equal(imported.truncated, false);
  assert.match(imported.content, /historical text from the old Actlume JSON runtime/i);
  assert.match(imported.content, /Requested tool: readFile/);
  assert.match(imported.content, /Historical result/);
});

test("legacy session import makes context truncation explicit and listing stays read-only", () => {
  const imported = formatLegacySessionImport({
    ...snapshot,
    history: Array.from({ length: 5 }, (_, index) => ({
      thought: "step " + index,
      action: { type: "action" as const, thought: "", tool: "readFile", input: { path: "file.ts" } },
      observation: "x".repeat(200)
    }))
  }, 500);
  assert.equal(imported.truncated, true);
  assert.match(imported.content, /Older imported history omitted/);
  assert.match(formatLegacySessionList([{
    id: snapshot.metadata.id,
    status: snapshot.metadata.status,
    historyLength: snapshot.history.length,
    updatedAt: snapshot.updatedAt,
    userTask: snapshot.metadata.userTask
  }]), /legacy-1/);
});
