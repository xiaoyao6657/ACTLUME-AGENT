import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { isConcurrencySafeTool, runToolBatch } from "./tool-batcher.js";
import type { AgentActionOutput, ToolContext, ToolDefinition } from "./types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("identifies concurrency-safe read tools", () => {
  const readFileTool = { name: "readFile", sideEffect: "read" } as ToolDefinition;
  const writeFileTool = { name: "writeFile", sideEffect: "write" } as ToolDefinition;
  assert.equal(isConcurrencySafeTool(readFileTool), true);
  assert.equal(isConcurrencySafeTool(writeFileTool), false);
});

test("runs consecutive safe tools in parallel", async () => {
  const tools: ToolDefinition[] = ["readFile", "searchText"].map((name) => ({
    name,
    description: name,
    sideEffect: "read",
    parameters: {},
    async run(input) {
      await delay(80);
      return { ok: true, content: `${name}:${JSON.stringify(input)}` };
    }
  }));
  const ctx: ToolContext = {
    cwd: process.cwd(),
    memoryDir: ".agent-memory",
    readonly: false,
    runId: "batch",
    permissionMode: "default",
    securityPolicy: {}
  };
  const actions: AgentActionOutput[] = [
    { type: "action", thought: "read", tool: "readFile", input: { path: "a" } },
    { type: "action", thought: "search", tool: "searchText", input: { pattern: "b" } }
  ];

  const started = performance.now();
  const results = await runToolBatch(tools, actions, ctx);
  const duration = performance.now() - started;
  assert.equal(results.length, 2);
  assert.equal(results.every((item) => item.result.ok), true);
  assert.equal(duration < 140, true);
});
