import { z } from "zod";
import { listMemories, recallMemories, saveMemory } from "../memory.js";
import { toolSuccess } from "../tool-result.js";
import type { MemoryType } from "../memory.js";
import type { ToolDefinition } from "../types.js";

const memoryTypeSchema = z.enum(["user", "feedback", "project", "reference"]);

const saveSchema = z.object({
  type: memoryTypeSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1)
});

const recallSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5)
});

export const memorySaveTool: ToolDefinition = {
  name: "memorySave",
  description: "Save a durable typed memory: user, feedback, project, or reference.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
      name: { type: "string" },
      description: { type: "string" },
      content: { type: "string" }
    },
    required: ["type", "name", "description", "content"]
  },
  async run(input, ctx) {
    const args = saveSchema.parse(input);
    const memory = await saveMemory(ctx.memoryDir, {
      type: args.type as MemoryType,
      name: args.name,
      description: args.description,
      content: args.content
    });
    return toolSuccess(`Saved memory ${memory.filename}`, memory);
  }
};

export const memoryListTool: ToolDefinition = {
  name: "memoryList",
  description: "List durable typed memories saved for this workspace.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {}
  },
  async run(_input, ctx) {
    const memories = await listMemories(ctx.memoryDir);
    const content =
      memories.length === 0
        ? "No typed memories saved."
        : memories
            .map((memory) => `- ${memory.filename} [${memory.type}] ${memory.name}: ${memory.description}`)
            .join("\n");
    return toolSuccess(content, { count: memories.length });
  }
};

export const memoryRecallTool: ToolDefinition = {
  name: "memoryRecall",
  description: "Recall relevant typed memories by keyword query.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", default: 5 }
    },
    required: ["query"]
  },
  async run(input, ctx) {
    const args = recallSchema.parse(input);
    const memories = await recallMemories(ctx.memoryDir, args.query, args.limit);
    const content =
      memories.length === 0
        ? "No relevant typed memories found."
        : memories
            .map(
              (memory, index) =>
                `#${index + 1} ${memory.name} [${memory.type}] (${memory.filename})\n${memory.description}\n${memory.content}`
            )
            .join("\n\n");
    return toolSuccess(content, { query: args.query, count: memories.length });
  }
};
