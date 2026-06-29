import type { ToolResult } from "./types.js";

export function toolSuccess(content: string, metadata?: unknown): ToolResult {
  return metadata === undefined ? { ok: true, content } : { ok: true, content, metadata };
}

export function toolFailure(params: {
  content: string;
  errorCode: string;
  retryable?: boolean;
  metadata?: unknown;
}): ToolResult {
  return {
    ok: false,
    content: params.content,
    errorCode: params.errorCode,
    retryable: params.retryable ?? false,
    ...(params.metadata === undefined ? {} : { metadata: params.metadata })
  };
}

export function formatToolResultForObservation(result: ToolResult): string {
  if (result.ok) {
    return result.content;
  }

  return [
    "[tool_error]",
    `code: ${result.errorCode}`,
    `retryable: ${result.retryable}`,
    "message:",
    result.content
  ].join("\n");
}
