import { z } from "zod";
import { EditWorkflowStore } from "../edit-workflow.js";
import type { ToolDefinition } from "../types.js";
import { toolSuccess } from "../tool-result.js";

const editPlanSchema = z.object({
  summary: z.string().min(1),
  expectedFiles: z.array(z.string().min(1)).default([]),
  steps: z.array(z.string().min(1)).default([])
});

export const editPlanTool: ToolDefinition = {
  name: "editPlan",
  description:
    "Create or replace the current edit plan before modifying workspace files. Include expected files and concise steps.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string" },
      expectedFiles: { type: "array", items: { type: "string" }, default: [] },
      steps: { type: "array", items: { type: "string" }, default: [] }
    },
    required: ["summary"]
  },
  async run(input, ctx) {
    const args = editPlanSchema.parse(input ?? {});
    const state = await new EditWorkflowStore(ctx.memoryDir, ctx.runId).setPlan({
      summary: args.summary,
      expectedFiles: args.expectedFiles,
      steps: args.steps
    });
    return toolSuccess(
      [
        `Edit plan saved: ${state.plan?.summary}`,
        `Expected files: ${state.plan?.expectedFiles.join(", ") || "none listed"}`,
        `Steps: ${state.plan?.steps.join(" | ") || "none listed"}`
      ].join("\n"),
      state.plan
    );
  }
};
