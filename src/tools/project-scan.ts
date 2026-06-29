import { z } from "zod";
import { formatProjectScan, scanProjectWithCache } from "../project-scan.js";
import type { ToolDefinition } from "../types.js";
import { toolSuccess } from "../tool-result.js";
import { resolveInsideCwd } from "./path-utils.js";

const projectScanSchema = z.object({
  root: z.string().default("."),
  depth: z.number().int().min(1).max(6).default(3),
  maxFiles: z.number().int().min(20).max(1000).default(300),
  refresh: z.boolean().default(false)
});

export const projectScanTool: ToolDefinition = {
  name: "projectScan",
  description:
    "Build a lightweight project index: tree, detected languages, key files, package scripts, and suggested check commands.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {
      root: { type: "string", default: "." },
      depth: { type: "number", default: 3 },
      maxFiles: { type: "number", default: 300 },
      refresh: { type: "boolean", default: false }
    }
  },
  async run(input, ctx) {
    const args = projectScanSchema.parse(input ?? {});
    const root = resolveInsideCwd(ctx.cwd, args.root);
    const result = await scanProjectWithCache(ctx.cwd, {
      root,
      maxDepth: args.depth,
      maxFiles: args.maxFiles,
      memoryDir: ctx.memoryDir,
      forceRefresh: args.refresh
    });
    const content = [
      `Cache: ${result.cacheHit ? "hit" : "miss"}`,
      `Summary: ${result.summaryPath ?? "<not persisted>"}`,
      formatProjectScan(result.scan)
    ].join("\n");
    return toolSuccess(content, result);
  }
};
