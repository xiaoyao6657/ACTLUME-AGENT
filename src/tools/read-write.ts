import { mkdir, readFile, writeFile, appendFile, access } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { pointerizeLongContent } from "../pointerize.js";
import { toolSuccess } from "../tool-result.js";
import { resolveInsideCwd } from "./path-utils.js";

const pathSchema = z.object({ path: z.string().min(1) });
const writeSchema = z.object({ path: z.string().min(1), content: z.string() });

export const readFileTool: ToolDefinition = {
  name: "readFile",
  description: "Read a UTF-8 text file from the project workspace.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"]
  },
  async run(input, ctx) {
    const args = pathSchema.parse(input);
    const filePath = resolveInsideCwd(ctx.cwd, args.path);
    const content = await readFile(filePath, "utf8");
    return toolSuccess(pointerizeLongContent({ content, filePath, cwd: ctx.cwd }).content, {
      path: args.path,
      chars: content.length
    });
  }
};

export const writeFileTool: ToolDefinition = {
  name: "writeFile",
  description: "Write UTF-8 content to a file inside the project workspace.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"]
  },
  async run(input, ctx) {
    const args = writeSchema.parse(input);
    const filePath = resolveInsideCwd(ctx.cwd, args.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, args.content, "utf8");
    return toolSuccess(`Wrote ${args.content.length} chars to ${args.path}`, {
      path: args.path,
      chars: args.content.length
    });
  }
};

export const appendFileTool: ToolDefinition = {
  name: "appendFile",
  description: "Append UTF-8 content to a file inside the project workspace.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"]
  },
  async run(input, ctx) {
    const args = writeSchema.parse(input);
    const filePath = resolveInsideCwd(ctx.cwd, args.path);
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, args.content, "utf8");
    return toolSuccess(`Appended ${args.content.length} chars to ${args.path}`, {
      path: args.path,
      chars: args.content.length
    });
  }
};

export const fileExistsTool: ToolDefinition = {
  name: "fileExists",
  description: "Check whether a file or directory exists inside the project workspace.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"]
  },
  async run(input, ctx) {
    const args = pathSchema.parse(input);
    const filePath = resolveInsideCwd(ctx.cwd, args.path);
    try {
      await access(filePath);
      return toolSuccess("true", { path: args.path, exists: true });
    } catch {
      return toolSuccess("false", { path: args.path, exists: false });
    }
  }
};
