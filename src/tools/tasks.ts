import { z } from "zod";
import { TaskTracker } from "../task-tracker.js";
import { toolFailure, toolSuccess } from "../tool-result.js";
import type { TaskItem, ToolDefinition } from "../types.js";

const addTaskSchema = z.object({
  title: z.string().min(1)
});

const updateTaskSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["todo", "doing", "done", "blocked"])
});

export const taskListTool: ToolDefinition = {
  name: "taskList",
  description: "List tracked task items for the current agent workspace.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {}
  },
  async run(_input, ctx) {
    const tasks = await new TaskTracker(ctx.memoryDir).list();
    return toolSuccess(formatTasks(tasks), { count: tasks.length });
  }
};

export const taskAddTool: ToolDefinition = {
  name: "taskAdd",
  description: "Add a task item to the local task tracker.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" }
    },
    required: ["title"]
  },
  async run(input, ctx) {
    const args = addTaskSchema.parse(input);
    const task = await new TaskTracker(ctx.memoryDir).add(args.title);
    return toolSuccess(`Added task ${task.id}: ${task.title}`, task);
  }
};

export const taskUpdateTool: ToolDefinition = {
  name: "taskUpdate",
  description: "Update a tracked task item status.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["todo", "doing", "done", "blocked"] }
    },
    required: ["id", "status"]
  },
  async run(input, ctx) {
    const args = updateTaskSchema.parse(input);
    const task = await new TaskTracker(ctx.memoryDir).updateStatus(args.id, args.status);
    if (!task) {
      return toolFailure({
        content: `Task not found: ${args.id}`,
        errorCode: "TASK_NOT_FOUND",
        retryable: true,
        metadata: { id: args.id }
      });
    }
    return toolSuccess(`Updated task ${task.id} to ${task.status}`, task);
  }
};

function formatTasks(tasks: TaskItem[]): string {
  if (tasks.length === 0) {
    return "No tracked tasks.";
  }

  return tasks.map((task) => `${task.id} [${task.status}] ${task.title}`).join("\n");
}
