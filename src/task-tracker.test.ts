import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskTracker } from "./task-tracker.js";

test("task tracker scopes shared memory by workspace identity", async () => {
  const memoryDir = await mkdtemp(join(tmpdir(), "actlume-task-tracker-scope-"));
  try {
    const repoA = join(memoryDir, "repo-a");
    const repoB = join(memoryDir, "repo-b");
    const sharedMemory = join(memoryDir, "shared-memory");
    const a = new TaskTracker(sharedMemory, repoA);
    const b = new TaskTracker(sharedMemory, repoB);
    const task = await a.add("Only repo A should see this");
    assert.deepEqual(await b.list(), []);
    assert.equal((await a.list())[0]?.id, task.id);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("concurrent task tracker updates do not lose entries or expose partial JSON", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-task-tracker-concurrent-"));
  try {
    const first = new TaskTracker(join(workspace, ".agent-memory"), workspace);
    const second = new TaskTracker(join(workspace, ".agent-memory"), workspace);
    const created = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      (index % 2 === 0 ? first : second).add(`Task ${index}`)
    ));
    const tasks = await first.list();
    assert.equal(tasks.length, 24);
    assert.equal(new Set(tasks.map((task) => task.id)).size, 24);
    await Promise.all(created.map((task, index) =>
      (index % 2 === 0 ? second : first).updateStatus(task.id, "done")
    ));
    assert.ok((await second.list()).every((task) => task.status === "done"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
