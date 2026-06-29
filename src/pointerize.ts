import { relative } from "node:path";

export type PointerizedContent = {
  content: string;
  pointer?: string;
};

export function pointerizeLongContent(params: {
  content: string;
  filePath?: string;
  cwd: string;
  maxChars?: number;
}): PointerizedContent {
  const maxChars = params.maxChars ?? 6000;
  if (params.content.length <= maxChars) {
    return { content: params.content };
  }

  const label = params.filePath
    ? relative(params.cwd, params.filePath).replaceAll("\\", "/")
    : "inline-content";
  const pointer = `[pointer:file:${label}#chars:0-${params.content.length}]`;

  return {
    pointer,
    content: `${pointer}\n${params.content.slice(0, maxChars)}\n[truncated: original content has ${params.content.length} chars]`
  };
}
