import { createHash } from "node:crypto";
import { z } from "zod";
import { captureMemoryApplicability, captureMemoryIdentity, listMemories, recallMemoriesDetailed, saveMemory } from "../memory.js";
import { appendRuntimeEvent } from "../runtime-events.js";
import { toolSuccess } from "../tool-result.js";
import type { MemoryType } from "../memory.js";
import type { ToolDefinition } from "../types.js";

const memoryTypeSchema = z.enum(["user", "feedback", "project", "reference"]);

const saveSchema = z.object({
  type: memoryTypeSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1),
  scope: z.enum(["repository", "worktree", "task", "user"]).optional(),
  sourceRefs: z.array(z.string().min(1)).max(20).optional(),
  applicabilityPaths: z.array(z.string().min(1)).max(20).optional(),
  supersedes: z.array(z.string().min(1)).max(50).optional()
});

const recallSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5)
});

export const memorySaveTool: ToolDefinition = {
  name: "memorySave",
  description: "Save a candidate typed memory scoped to this repository, worktree, task, or explicitly user-wide. New memories remain candidates until a person reviews and promotes them; user-wide promotion requires a separate cross-workspace consent.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
      name: { type: "string" },
      description: { type: "string" },
      content: { type: "string" },
      scope: { type: "string", enum: ["repository", "worktree", "task", "user"] },
      sourceRefs: { type: "array", items: { type: "string" } },
      applicabilityPaths: { type: "array", items: { type: "string" } },
      supersedes: { type: "array", items: { type: "string" }, description: "Memory IDs explicitly replaced by this candidate; promotion refuses cross-scope conflicts." }
    },
    required: ["type", "name", "description", "content"]
  },
  async run(input, ctx) {
    const args = saveSchema.parse(input);
    const applicability = await captureMemoryApplicability(ctx.cwd, args.applicabilityPaths ?? []);
    const identity = await captureMemoryIdentity(ctx.cwd, {
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      branchId: ctx.branchId
    });
    const memory = await saveMemory(ctx.memoryDir, {
      type: args.type as MemoryType,
      name: args.name,
      description: args.description,
      content: args.content,
      scope: args.scope ?? "repository",
      sourceRefs: args.sourceRefs ?? [],
      evidenceType: "candidate",
      status: "candidate",
      applicability,
      identity,
      supersedes: args.supersedes ?? []
    }, { workspace: ctx.cwd, identity });
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
    const recall = await recallMemoriesDetailed(ctx.memoryDir, args.query, args.limit, ctx.cwd, {
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      branchId: ctx.branchId
    });
    await appendRuntimeEvent(ctx.memoryDir, {
      kind: "memory_retrieved",
      workspace: ctx.cwd,
      sessionId: ctx.sessionId ?? ctx.runId,
      runId: ctx.runId,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      ...(ctx.branchId ? { branchId: ctx.branchId } : {}),
      attributes: {
        retrievalSource: "memoryRecall",
        queryHash: createHash("sha256").update(args.query).digest("hex"),
        selected: recall.selected.map((memory) => `${memory.filename}:${memory.reason}`),
        rejected: recall.rejected.map((memory) => `${memory.filename}:${memory.reason}`)
      }
    });
    const memories = recall.memories;
    const content =
      memories.length === 0
        ? "No relevant typed memories found."
        : memories
            .map(
              (memory, index) =>
                `#${index + 1} ${memory.name} [${memory.type}] (${memory.filename})\n${memory.description}\n${memory.content}`
            )
            .join("\n\n");
    return toolSuccess(content, { query: args.query, count: memories.length, selected: recall.selected, rejected: recall.rejected });
  }
};
