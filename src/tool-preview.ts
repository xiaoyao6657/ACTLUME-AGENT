import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolConfirmationRequest, ToolContext, ToolDefinition } from "./types.js";
import { resolveInsideCwd } from "./tools/path-utils.js";

const writeSchema = z.object({ path: z.string().min(1), content: z.string() });
const appendSchema = z.object({ path: z.string().min(1), content: z.string() });
const patchSchema = z.object({ patch: z.string().min(1) });

export async function buildToolConfirmationRequest(
  tool: ToolDefinition,
  input: unknown,
  ctx: ToolContext
): Promise<ToolConfirmationRequest> {
  return {
    toolName: tool.name,
    sideEffect: tool.sideEffect,
    input,
    preview: await buildToolPreview(tool.name, input, ctx)
  };
}

async function buildToolPreview(toolName: string, input: unknown, ctx: ToolContext): Promise<string | undefined> {
  if (toolName === "writeFile") {
    const args = writeSchema.parse(input);
    const oldContent = await readOptionalFile(ctx.cwd, args.path);
    return makeUnifiedPreview(args.path, oldContent ?? "", args.content, oldContent === undefined);
  }

  if (toolName === "appendFile") {
    const args = appendSchema.parse(input);
    const oldContent = await readOptionalFile(ctx.cwd, args.path);
    const base = oldContent ?? "";
    return makeUnifiedPreview(args.path, base, `${base}${args.content}`, oldContent === undefined);
  }

  if (toolName === "applyPatch") {
    const args = patchSchema.parse(input);
    return truncatePreview(args.patch, 12000);
  }

  if (toolName === "shell") {
    return `Command preview:\n${JSON.stringify(input, null, 2)}`;
  }

  return `Tool input preview:\n${JSON.stringify(input, null, 2)}`;
}

async function readOptionalFile(cwd: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(resolveInsideCwd(cwd, path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function makeUnifiedPreview(path: string, oldContent: string, newContent: string, isNewFile: boolean): string {
  const oldLines = oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix + prefix < oldLines.length &&
    suffix + prefix < newLines.length &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextBefore = Math.max(0, prefix - 3);
  const oldChangedEnd = oldLines.length - suffix;
  const newChangedEnd = newLines.length - suffix;
  const contextAfterOld = Math.min(oldLines.length, oldChangedEnd + 3);
  const contextAfterNew = Math.min(newLines.length, newChangedEnd + 3);
  const lines = [
    `--- ${isNewFile ? "/dev/null" : path}`,
    `+++ ${path}`,
    `@@ preview @@`
  ];

  for (const line of oldLines.slice(contextBefore, prefix)) {
    lines.push(` ${line}`);
  }
  for (const line of oldLines.slice(prefix, oldChangedEnd)) {
    lines.push(`-${line}`);
  }
  for (const line of newLines.slice(prefix, newChangedEnd)) {
    lines.push(`+${line}`);
  }
  for (const line of newLines.slice(newChangedEnd, contextAfterNew)) {
    lines.push(` ${line}`);
  }

  if (contextAfterOld < oldLines.length || contextAfterNew < newLines.length) {
    lines.push("...");
  }

  return truncatePreview(lines.join("\n"), 12000);
}

function truncatePreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[preview truncated: ${text.length} chars total]`;
}
