import { ZodError } from "zod";
import { toolFailure } from "./tool-result.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

export async function runRegisteredTool(
  tools: ToolDefinition[],
  toolName: string,
  input: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const tool = tools.find((item) => item.name === toolName);
  if (!tool) {
    const names = tools.map((item) => item.name).join(", ");
    return toolFailure({
      content: `Unknown tool: ${toolName}. Available tools: ${names}`,
      errorCode: "UNKNOWN_TOOL",
      retryable: true,
      metadata: { requestedTool: toolName, availableTools: tools.map((item) => item.name) }
    });
  }

  if (ctx.readonly && tool.sideEffect !== "read") {
    return toolFailure({
      content: `Readonly mode blocked ${tool.name} because it is a ${tool.sideEffect} tool.`,
      errorCode: "READONLY_BLOCKED",
      retryable: false,
      metadata: { toolName: tool.name, sideEffect: tool.sideEffect }
    });
  }

  try {
    return await tool.run(input, ctx);
  } catch (error) {
    if (error instanceof ZodError) {
      return toolFailure({
        content: `Invalid input for ${toolName}: ${error.message}`,
        errorCode: "INVALID_TOOL_INPUT",
        retryable: true,
        metadata: { issues: error.issues }
      });
    }

    return toolFailure({
      content: `Tool ${toolName} failed: ${(error as Error).message}`,
      errorCode: "TOOL_EXCEPTION",
      retryable: true,
      metadata: { toolName }
    });
  }
}
