import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { filterSubAgentTools, getSubAgentSystemPrompt, normalizeSubAgentType } from "../subagent.js";
import { summarizeText } from "../summary.js";
import { toolSuccess } from "../tool-result.js";
import type { ToolDefinition } from "../types.js";

const agentSchema = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  type: z.enum(["explore", "plan", "general"]).default("general"),
  maxSteps: z.number().int().min(1).max(20).default(8)
});

// Sub-agent answers exceeding this limit are truncated in the parent context
// and the full output is saved as an artifact.
const subAgentAnswerTruncateChars = 3000;

export const agentTool: ToolDefinition = {
  name: "agent",
  description:
    "Launch a read-only sub-agent for research and investigation. Types: explore (code search), plan (architecture analysis), general (task research). All sub-agents are read-only — the parent performs all file edits. Output is summarized if large.",
  sideEffect: "execute",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short description of the delegated task." },
      prompt: { type: "string", description: "Detailed delegated task instructions." },
      type: { type: "string", enum: ["explore", "plan", "general"], default: "general" },
      maxSteps: { type: "number", default: 8 }
    },
    required: ["description", "prompt"]
  },
  async run(input, ctx) {
    const args = agentSchema.parse(input);
    const type = normalizeSubAgentType(args.type);
    const subRunId = `${ctx.runId}-sub-${crypto.randomUUID().slice(0, 8)}`;
    const [{ runAgent }, registry] = await Promise.all([
      import("../agent.js"),
      import("./registry.js")
    ]);
    const subTools = filterSubAgentTools(type, registry.tools);
    const delegatedPrompt = [
      getSubAgentSystemPrompt(type),
      "",
      `Delegated task: ${args.description}`,
      "",
      args.prompt,
      "",
      "Important: Keep your final answer concise and structured. Focus on actionable findings with file paths and line references."
    ].join("\n");
    const result = await runAgent({
      userTask: delegatedPrompt,
      cwd: ctx.cwd,
      memoryDir: ctx.memoryDir,
      maxSteps: args.maxSteps,
      readonly: ctx.readonly || type === "explore" || type === "plan",
      runId: subRunId,
      tools: subTools,
      autoConfirm: ctx.permissionMode === "bypassPermissions",
      permissionMode: type === "explore" || type === "plan" ? "plan" : ctx.permissionMode,
      securityPolicy: ctx.securityPolicy
    });

    const { truncated, artifactPath } = await maybeTruncateSubAgentAnswer(
      ctx.memoryDir,
      subRunId,
      result.answer
    );

    return toolSuccess(
      [
        `Sub-agent ${type} finished with status ${result.status}.`,
        `Steps: ${result.stepsUsed}; tool calls: ${result.toolCalls}.`,
        artifactPath ? `Full output saved to artifact: ${artifactPath}` : "",
        "",
        truncated
      ].filter(Boolean).join("\n"),
      {
        type,
        status: result.status,
        runId: result.runId,
        stepsUsed: result.stepsUsed,
        toolCalls: result.toolCalls,
        logPath: result.logPath,
        truncated: artifactPath !== undefined,
        answerChars: result.answer.length
      }
    );
  }
};

async function maybeTruncateSubAgentAnswer(
  memoryDir: string,
  subRunId: string,
  answer: string
): Promise<{ truncated: string; artifactPath?: string }> {
  if (answer.length <= subAgentAnswerTruncateChars) {
    return { truncated: answer };
  }

  const dir = join(memoryDir, "artifacts", subRunId);
  await mkdir(dir, { recursive: true });
  const artifactPath = join(dir, "sub-agent-answer.txt");
  await writeFile(artifactPath, answer, "utf8");

  const preview = summarizeText(answer, Math.floor(subAgentAnswerTruncateChars * 0.4));
  const tail = answer.slice(-Math.floor(subAgentAnswerTruncateChars * 0.5)).trimStart();

  return {
    truncated: [
      `[Sub-agent answer truncated: ${answer.length} chars → ${subAgentAnswerTruncateChars} limit]`,
      `Full output: ${artifactPath}`,
      "",
      preview,
      "...",
      tail
    ].join("\n"),
    artifactPath
  };
}
