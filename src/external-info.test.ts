import test from "node:test";
import assert from "node:assert/strict";
import { hasMcpSearchTool, requiresRealtimeExternalInfo } from "./external-info.js";
import type { ToolDefinition } from "./types.js";

test("detects Chinese realtime information requests", () => {
  assert.equal(requiresRealtimeExternalInfo("查询今天世界杯最新比分"), true);
});

test("detects MCP search-like tools", () => {
  const tools: ToolDefinition[] = [
    {
      name: "mcp_search_query",
      description: "Search the web",
      sideEffect: "read",
      source: "mcp",
      parameters: {},
      async run() {
        return { ok: true, content: "ok" };
      }
    }
  ];
  assert.equal(hasMcpSearchTool(tools), true);
});
