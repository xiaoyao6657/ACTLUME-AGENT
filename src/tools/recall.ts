import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { formatRecallResults, recallActions } from "../recall.js";
import { toolSuccess } from "../tool-result.js";

const recallSchema = z.object({
  keyword: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10)
});

export const recallTool: ToolDefinition = {
  name: "recall",
  description: "Search prior action records from .agent-memory/actions.jsonl by keyword.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {
      keyword: { type: "string" },
      limit: { type: "number", default: 10 }
    },
    required: ["keyword"]
  },
  async run(input, ctx) {
    const args = recallSchema.parse(input);
    const records = await recallActions(ctx.memoryDir, args.keyword, args.limit);
    return toolSuccess(formatRecallResults(records), {
      keyword: args.keyword,
      resultCount: records.length
    });
  }
};
