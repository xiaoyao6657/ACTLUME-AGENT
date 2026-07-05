import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildMemoryPromptSection, listMemories, recallMemories, saveMemory } from "./memory.js";
import { defaultSecurityPolicy } from "./security.js";
import { runRegisteredTool } from "./tool-scheduler.js";
import { tools } from "./tools/registry.js";
import type { ToolContext } from "./types.js";

test("saves, indexes, and recalls typed memories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "actlume-memory-"));
  try {
    const memory = await saveMemory(dir, {
      type: "project",
      name: "GraphQL migration",
      description: "API migration deadline",
      content: "Move REST endpoints to GraphQL before Q2."
    });

    const memories = await listMemories(dir);
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.filename, memory.filename);

    const recalled = await recallMemories(dir, "GraphQL deadline");
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0]?.name, "GraphQL migration");

    const index = await readFile(join(dir, "memories", "MEMORY.md"), "utf8");
    assert.match(index, /GraphQL migration/);

    const prompt = await buildMemoryPromptSection(dir);
    assert.match(prompt, /Typed Memory/);
    assert.match(prompt, /GraphQL migration/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory tools save and recall typed memories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "actlume-memory-tool-"));
  try {
    const ctx: ToolContext = {
      cwd,
      memoryDir: join(cwd, ".agent-memory"),
      readonly: false,
      runId: "memory-run",
      permissionMode: "default",
      securityPolicy: defaultSecurityPolicy
    };

    const saved = await runRegisteredTool(tools, "memorySave", {
      type: "feedback",
      name: "style preference",
      description: "Functional style",
      content: "Prefer map/filter over loops."
    }, ctx);
    assert.equal(saved.ok, true);

    const recalled = await runRegisteredTool(tools, "memoryRecall", { query: "functional loops" }, ctx);
    assert.equal(recalled.ok, true);
    assert.match(recalled.content, /map\/filter/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
