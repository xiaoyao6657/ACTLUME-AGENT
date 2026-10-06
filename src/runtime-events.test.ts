import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendRuntimeEvent, findLatestRuntimeSession, readRuntimeEvents, runtimeEventPath, setRuntimeEventContext } from "./runtime-events.js";

test("runtime events append in order and latest-session lookup is workspace scoped", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "actlume-events-"));
  try {
    await Promise.all([
      appendRuntimeEvent(memoryDir, {
        kind: "session_started",
        workspace: "C:/repo-a",
        sessionId: "session-a",
        status: "idle",
        attributes: { sessionFile: "C:/repo-a/.agent-memory/pi-sessions/session-a.jsonl" }
      }),
      appendRuntimeEvent(memoryDir, {
        kind: "run_started",
        workspace: "C:/repo-a",
        sessionId: "session-a",
        runId: "run-a",
        status: "running"
      })
    ]);
    await appendRuntimeEvent(memoryDir, {
      kind: "session_started",
      workspace: "C:/repo-b",
      sessionId: "session-b",
      status: "idle",
      attributes: { sessionFile: "C:/repo-b/.agent-memory/pi-sessions/session-b.jsonl" }
    });

    const events = await readRuntimeEvents(memoryDir, "session-a");
    assert.deepEqual(events.map((event) => event.kind), ["session_started", "run_started"]);
    assert.equal(await findLatestRuntimeSession(memoryDir, "C:/repo-a"), "session-a");
    assert.equal(await findLatestRuntimeSession(memoryDir, "C:/missing"), undefined);
    assert.match(runtimeEventPath(memoryDir, "../not-a-safe-id"), /events[\\/]\.\._not-a-safe-id\.jsonl$/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runtime events inherit agent and parent-run correlation without replacing explicit values", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "actlume-agent-events-"));
  try {
    setRuntimeEventContext(memoryDir, { agentId: "agent-child", parentRunId: "parent-run" });
    await appendRuntimeEvent(memoryDir, {
      kind: "run_started",
      workspace: "/repo",
      sessionId: "child-session",
      runId: "child-run",
      status: "running"
    });
    await appendRuntimeEvent(memoryDir, {
      kind: "run_finished",
      workspace: "/repo",
      sessionId: "child-session",
      runId: "child-run",
      parentRunId: "explicit-parent",
      agentId: "explicit-agent",
      status: "completed"
    });
    const events = await readRuntimeEvents(memoryDir, "child-session");
    assert.equal(events[0]?.agentId, "agent-child");
    assert.equal(events[0]?.parentRunId, "parent-run");
    assert.equal(events[1]?.agentId, "explicit-agent");
    assert.equal(events[1]?.parentRunId, "explicit-parent");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runtime event reader refuses to reinterpret an unknown schema as version 1", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "actlume-events-schema-"));
  try {
    const path = runtimeEventPath(memoryDir, "future-session");
    await mkdir(join(memoryDir, "events"), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 9, eventId: "future", kind: "run_finished", sessionId: "future-session" }) + "\n");
    await assert.rejects(readRuntimeEvents(memoryDir, "future-session"), /Unsupported or malformed runtime event.*schemaVersion 1/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
