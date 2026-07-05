import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  finishSession,
  getLatestSessionSnapshot,
  listSessionSnapshots,
  loadSessionSnapshot,
  saveSessionSnapshot,
  startSession
} from "./session.js";
import type { AgentHistoryItem } from "./types.js";

test("persists resumable session snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actlume-session-"));
  try {
    const session = await startSession(dir, "read package metadata", "previous-session");
    const history: AgentHistoryItem[] = [
      {
        thought: "Read package metadata.",
        action: {
          type: "action",
          thought: "Read file.",
          tool: "readFile",
          input: { path: "package.json" }
        },
        observation: "package name is actlume"
      }
    ];
    const finished = await finishSession(dir, session, "completed");
    await saveSessionSnapshot(dir, finished, history, "done");

    const loaded = await loadSessionSnapshot(dir, session.id);
    assert.equal(loaded?.metadata.id, session.id);
    assert.equal(loaded?.metadata.resumedFrom, "previous-session");
    assert.equal(loaded?.history[0]?.action.tool, "readFile");
    assert.equal(loaded?.answer, "done");

    const listed = await listSessionSnapshots(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.historyLength, 1);

    const latest = await getLatestSessionSnapshot(dir);
    assert.equal(latest?.metadata.id, session.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
