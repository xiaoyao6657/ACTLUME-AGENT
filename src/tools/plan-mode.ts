import { z } from "zod";
import { getPlanFilePath, readPlanFile, writePlanFile } from "../plan-mode.js";
import { toolFailure, toolSuccess } from "../tool-result.js";
import type { ToolDefinition } from "../types.js";

const stepSchema = z.object({
  title: z.string().min(1),
  content: z.string().default("")
});

const writePlanSchema = z.object({
  title: z.string().min(1).default("Implementation plan"),
  content: z.string().min(1),
  steps: z.array(stepSchema).default([])
});

const updatePlanSchema = z.object({
  stepIndex: z.number().int().min(0),
  status: z.enum(["done", "pending", "skipped"]).default("done"),
  note: z.string().default("")
});

export const enterPlanModeTool: ToolDefinition = {
  name: "enterPlanMode",
  description: "Show the current plan-mode file path and planning constraints.",
  sideEffect: "read",
  parameters: { type: "object", properties: {} },
  async run(_input, ctx) {
    return toolSuccess(
      [
        `Plan file: ${getPlanFilePath(ctx.memoryDir, ctx.runId)}`,
        "Inspect with read-only tools, then call writePlan with steps.",
        "When ready for review, call exitPlanMode."
      ].join("\n"),
      { planPath: getPlanFilePath(ctx.memoryDir, ctx.runId), permissionMode: ctx.permissionMode }
    );
  }
};

export const writePlanTool: ToolDefinition = {
  name: "writePlan",
  description:
    "Write or replace the plan-mode markdown plan with optional structured steps for progress tracking.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", default: "Implementation plan" },
      content: { type: "string", description: "Markdown plan body." },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string", default: "" }
          },
          required: ["title"]
        },
        default: []
      }
    },
    required: ["content"]
  },
  async run(input, ctx) {
    const args = writePlanSchema.parse(input);
    const markdown = buildPlanMarkdown(args.title, args.content, args.steps);
    const path = await writePlanFile(ctx.memoryDir, ctx.runId, markdown);
    const stepCount = args.steps.length;
    return toolSuccess(
      stepCount > 0
        ? `Plan written to ${path} with ${stepCount} structured steps. Use updatePlan to track progress.`
        : `Plan written to ${path}`,
      { path, chars: markdown.length, stepCount }
    );
  }
};

export const updatePlanTool: ToolDefinition = {
  name: "updatePlan",
  description:
    "Update a plan step's completion status. Step indices start at 0 matching writePlan order.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: {
      stepIndex: { type: "number", description: "Zero-based step index from writePlan order." },
      status: { type: "string", enum: ["done", "pending", "skipped"], default: "done" },
      note: { type: "string", default: "", description: "Optional completion note." }
    },
    required: ["stepIndex"]
  },
  async run(input, ctx) {
    const args = updatePlanSchema.parse(input);

    let plan;
    try {
      plan = await readPlanFile(ctx.memoryDir, ctx.runId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return toolFailure({
          content: "No plan exists yet. Call writePlan first.",
          errorCode: "PLAN_NOT_FOUND",
          retryable: true,
          metadata: { path: getPlanFilePath(ctx.memoryDir, ctx.runId) }
        });
      }
      throw error;
    }

    const updated = updateStepInMarkdown(plan.content, args.stepIndex, args.status, args.note);
    if (!updated.ok) {
      return toolFailure({
        content: updated.error,
        errorCode: "PLAN_STEP_NOT_FOUND",
        retryable: true,
        metadata: { stepIndex: args.stepIndex }
      });
    }

    const path = await writePlanFile(ctx.memoryDir, ctx.runId, updated.content);
    const statusIcon = args.status === "done" ? "✅" : args.status === "skipped" ? "⏭️" : "⬜";
    return toolSuccess(`${statusIcon} Step ${args.stepIndex} → ${args.status}. ${args.note}`.trim(), {
      path,
      stepIndex: args.stepIndex,
      status: args.status
    });
  }
};

export const readPlanTool: ToolDefinition = {
  name: "readPlan",
  description: "Read the current plan-mode markdown plan with step completion status.",
  sideEffect: "read",
  parameters: { type: "object", properties: {} },
  async run(_input, ctx) {
    try {
      const plan = await readPlanFile(ctx.memoryDir, ctx.runId);
      const progress = summarizePlanProgress(plan.content);
      return toolSuccess(
        progress ? `${progress}\n\n${plan.content}` : plan.content,
        { path: plan.path, chars: plan.content.length }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return toolFailure({
          content: "No plan has been written yet. Call writePlan first.",
          errorCode: "PLAN_NOT_FOUND",
          retryable: true,
          metadata: { path: getPlanFilePath(ctx.memoryDir, ctx.runId) }
        });
      }
      throw error;
    }
  }
};

export const exitPlanModeTool: ToolDefinition = {
  name: "exitPlanMode",
  description: "Finish plan mode and return the plan with approval choices and step progress.",
  sideEffect: "read",
  parameters: { type: "object", properties: {} },
  async run(_input, ctx) {
    try {
      const plan = await readPlanFile(ctx.memoryDir, ctx.runId);
      const progress = summarizePlanProgress(plan.content);
      return toolSuccess(
        [
          "Plan is ready for review.",
          progress ?? "",
          "",
          plan.content,
          "",
          "Approval:",
          "1. `/plan approve` — approve and continue.",
          "2. `/plan execute` — approve and let the agent implement.",
          "3. `/plan manual` — keep for manual execution.",
          "4. Continue chatting to revise.",
          "",
          "During execution, use updatePlan(stepIndex, status) to track progress."
        ].filter(Boolean).join("\n"),
        { path: plan.path, chars: plan.content.length, approvalRequired: true }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return toolFailure({
          content: "No plan written yet. Call writePlan first.",
          errorCode: "PLAN_NOT_FOUND",
          retryable: true,
          metadata: { path: getPlanFilePath(ctx.memoryDir, ctx.runId) }
        });
      }
      throw error;
    }
  }
};

// ── helpers ──────────────────────────────────────────────────────────

function buildPlanMarkdown(
  title: string,
  content: string,
  steps: { title: string; content?: string }[]
): string {
  const lines = [`# ${title.trim()}`, "", content.trim()];

  if (steps.length > 0) {
    lines.push("", "## Steps", "");
    for (const step of steps) {
      const body = step.content ? ` — ${step.content}` : "";
      lines.push(`- [ ] ${step.title}${body}`);
    }
    lines.push("", "Mark steps as done with updatePlan(stepIndex, \"done\").");
  }

  return `${lines.join("\n")}\n`;
}

function updateStepInMarkdown(
  content: string,
  stepIndex: number,
  status: string,
  note: string
): { ok: true; content: string } | { ok: false; error: string } {
  const lines = content.split("\n");
  let stepCount = 0;
  let found = false;

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^- \[([ x])\] (.+)$/);
    if (!match) continue;

    if (stepCount === stepIndex) {
      const checkbox = status === "done" ? "x" : " ";
      const suffix = note ? ` (${status}: ${note})` : ` (${status})`;
      lines[i] = `- [${checkbox}] ${match[2]}${suffix}`;
      found = true;
      break;
    }
    stepCount += 1;
  }

  if (!found) {
    return { ok: false, error: `Step ${stepIndex} not found (${stepCount} steps exist).` };
  }

  return { ok: true, content: lines.join("\n") };
}

function summarizePlanProgress(content: string): string | null {
  const steps: { done: number; total: number } = { done: 0, total: 0 };
  for (const line of content.split("\n")) {
    const match = line.match(/^- \[(.)\] /);
    if (!match) continue;
    steps.total += 1;
    if (match[1] === "x") steps.done += 1;
  }
  if (steps.total === 0) return null;
  return `Progress: ${steps.done}/${steps.total} steps done.`;
}
