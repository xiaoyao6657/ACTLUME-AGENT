import { mkdir, readFile, writeFile, appendFile, access } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { pointerizeLongContent } from "../pointerize.js";
import { toolSuccess } from "../tool-result.js";
import { resolveInsideCwd, toProjectRelative } from "./path-utils.js";

const maxFullReadChars = 20000;
const maxFullReadLines = 400;

const readSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  lineCount: z.number().int().min(1).max(2000).optional(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(2000).optional()
});
const pathSchema = z.object({ path: z.string().min(1) });
const writeSchema = z.object({ path: z.string().min(1), content: z.string() });
const replaceTextSchema = z.object({
  path: z.string().min(1),
  search: z.string().min(1),
  replacement: z.string(),
  replaceAll: z.boolean().default(false)
});
const insertTextSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    after: z.string().min(1).optional(),
    before: z.string().min(1).optional(),
    line: z.number().int().min(1).optional()
  })
  .refine((value) => [value.after, value.before, value.line].filter((item) => item !== undefined).length === 1, {
    message: "Provide exactly one insertion anchor: after, before, or line."
  });
const lineRangeEditSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1),
  lineCount: z.number().int().min(1).max(2000),
  content: z.string()
});
const insertAtLineSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1),
  content: z.string()
});
const readTailSchema = z.object({
  path: z.string().min(1),
  lineCount: z.number().int().min(1).max(2000).default(80)
});

export const readFileTool: ToolDefinition = {
  name: "readFile",
  description:
    "Read a UTF-8 text file from the project workspace. For large files, use startLine/lineCount, or offset/limit as line-based aliases, to read a focused range.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      startLine: { type: "number", description: "1-based first line to read." },
      lineCount: { type: "number", description: "Number of lines to read from startLine." },
      offset: { type: "number", description: "1-based first line to read; alias for startLine." },
      limit: { type: "number", description: "Number of lines to read; alias for lineCount." }
    },
    required: ["path"]
  },
  async run(input, ctx) {
    const args = readSchema.parse(input);
    const filePath = resolveInsideCwd(ctx.cwd, args.path);
    const content = await readFile(filePath, "utf8");

    const startLine = args.startLine ?? args.offset;
    const lineCount = args.lineCount ?? args.limit;
    if (startLine !== undefined || lineCount !== undefined) {
      const range = sliceLines(content, startLine ?? 1, lineCount ?? 200, toProjectRelative(ctx.cwd, filePath));
      return toolSuccess(range.content, {
        path: args.path,
        chars: content.length,
        totalLines: range.totalLines,
        startLine: range.startLine,
        endLine: range.endLine,
        lineCount: range.endLine >= range.startLine ? range.endLine - range.startLine + 1 : 0,
        ranged: true
      });
    }

    const totalLines = countLines(content);
    if (content.length > maxFullReadChars || totalLines > maxFullReadLines) {
      return {
        ok: false,
        content:
          `File is large (${content.length} chars, ${totalLines} lines). ` +
          "Use readFile with startLine/lineCount, or use searchText to locate focused ranges before reading.",
        errorCode: "READ_RANGE_REQUIRED",
        retryable: true,
        metadata: {
          path: args.path,
          chars: content.length,
          totalLines,
          suggestedInput: { path: args.path, startLine: 1, lineCount: 120 }
        }
      };
    }

    return toolSuccess(pointerizeLongContent({ content, filePath, cwd: ctx.cwd }).content, {
      path: args.path,
      chars: content.length,
      totalLines,
      ranged: false
    });
  }
};

function sliceLines(
  content: string,
  startLine: number,
  lineCount: number,
  label: string
): { content: string; totalLines: number; startLine: number; endLine: number } {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const normalizedStart = Math.min(Math.max(1, startLine), totalLines);
  const endLine = Math.min(totalLines, normalizedStart + lineCount - 1);
  const selected = lines.slice(normalizedStart - 1, endLine).join("\n");
  return {
    content: `[pointer:file:${label}#lines:${normalizedStart}-${endLine}/${totalLines}]\n${selected}`,
    totalLines,
    startLine: normalizedStart,
    endLine
  };
}

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r?\n/).length;
}

function splitLinesForEdit(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function joinLinesForEdit(lines: string[], originalContent: string): string {
  const newline = originalContent.includes("\r\n") ? "\r\n" : "\n";
  const joined = lines.join(newline);
  return originalContent.endsWith("\n") ? `${joined}${newline}` : joined;
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const foundAt = content.indexOf(search, index);
    if (foundAt === -1) {
      return count;
    }
    count += 1;
    index = foundAt + search.length;
  }
}

function textAnchorFailure(path: string, anchor: "after" | "before") {
  return {
    ok: false as const,
    content: `The ${anchor} anchor was not found in ${path}.`,
    errorCode: "TEXT_ANCHOR_NOT_FOUND",
    retryable: true,
    metadata: { path, anchor }
  };
}

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

export const appendToFileTool: ToolDefinition = {
  name: "appendToFile",
  description: "Append text to the end of a workspace file. Prefer this for adding tests or notes at EOF.",
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
    return toolSuccess(`Appended ${args.content.length} chars to ${args.path}.`, {
      path: args.path,
      chars: args.content.length
    });
  }
};

export const replaceTextTool: ToolDefinition = {
  name: "replaceText",
  description:
    "Replace an exact text snippet in a workspace file. Safer than hand-written unified diffs for small targeted edits.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      search: { type: "string", description: "Exact text to find." },
      replacement: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean", default: false }
    },
    required: ["path", "search", "replacement"]
  },
  async run(input, ctx) {
    const args = replaceTextSchema.parse(input);
    const filePath = resolveInsideCwd(ctx.cwd, args.path);
    const content = await readFile(filePath, "utf8");
    const matches = countOccurrences(content, args.search);
    if (matches === 0) {
      const largeSnippetAdvice =
        args.search.length > 500 || args.search.includes("\n")
          ? " For large or multi-line snippets, read a focused range to get current line numbers, then use replaceLines instead of another exact replaceText attempt."
          : "";
      return {
        ok: false,
        content: `Search text was not found in ${args.path}.${largeSnippetAdvice}`,
        errorCode: "TEXT_NOT_FOUND",
        retryable: true,
        metadata: { path: args.path, searchLength: args.search.length }
      };
    }
    if (!args.replaceAll && matches > 1) {
      return {
        ok: false,
        content: `Search text matched ${matches} times in ${args.path}. Provide a more specific snippet or set replaceAll=true.`,
        errorCode: "TEXT_MATCH_NOT_UNIQUE",
        retryable: true,
        metadata: { path: args.path, matches }
      };
    }

    const next = args.replaceAll ? content.split(args.search).join(args.replacement) : content.replace(args.search, args.replacement);
    await writeFile(filePath, next, "utf8");
    return toolSuccess(`Replaced ${args.replaceAll ? matches : 1} occurrence(s) in ${args.path}.`, {
      path: args.path,
      matches: args.replaceAll ? matches : 1
    });
  }
};

export const insertTextTool: ToolDefinition = {
  name: "insertText",
  description:
    "Insert text into a workspace file using an exact before/after anchor or a 1-based line number. Useful for adding tests or imports without hand-writing a patch.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string", description: "Text to insert." },
      after: { type: "string", description: "Exact anchor; insert content immediately after this text." },
      before: { type: "string", description: "Exact anchor; insert content immediately before this text." },
      line: { type: "number", description: "1-based line number; insert content before this line." }
    },
    required: ["path", "content"]
  },
  async run(input, ctx) {
    const args = insertTextSchema.parse(input);
    const filePath = resolveInsideCwd(ctx.cwd, args.path);
    const content = await readFile(filePath, "utf8");
    let next: string;
    let anchor: string | number;

    if (args.after !== undefined) {
      const index = content.indexOf(args.after);
      if (index === -1) {
        return textAnchorFailure(args.path, "after");
      }
      const insertAt = index + args.after.length;
      const insertion = normalizeAnchoredInsertion(args.path, args.after, args.content, content[insertAt]);
      next = `${content.slice(0, insertAt)}${insertion}${content.slice(insertAt)}`;
      anchor = "after";
    } else if (args.before !== undefined) {
      const index = content.indexOf(args.before);
      if (index === -1) {
        return textAnchorFailure(args.path, "before");
      }
      next = `${content.slice(0, index)}${args.content}${content.slice(index)}`;
      anchor = "before";
    } else {
      const lines = content.split(/\r?\n/);
      const line = args.line ?? 1;
      if (line > lines.length + 1) {
        return {
          ok: false,
          content: `Line ${line} is outside ${args.path}, which has ${lines.length} lines.`,
          errorCode: "LINE_OUT_OF_RANGE",
          retryable: true,
          metadata: { path: args.path, line, totalLines: lines.length }
        };
      }
      lines.splice(line - 1, 0, args.content.replace(/\r?\n$/, ""));
      next = lines.join("\n");
      anchor = line;
    }

    await writeFile(filePath, next, "utf8");
    return toolSuccess(`Inserted ${args.content.length} chars into ${args.path}.`, { path: args.path, anchor });
  }
};

function normalizeAnchoredInsertion(path: string, anchor: string, insertion: string, nextChar: string | undefined): string {
  if (
    path.endsWith(".py") &&
    /^(from|import)\s+/.test(anchor.trim()) &&
    /^(from|import)\s+/.test(insertion.trimStart()) &&
    !anchor.endsWith("\n") &&
    !insertion.startsWith("\n") &&
    nextChar === "\n"
  ) {
    return `\n${insertion}`;
  }

  return insertion;
}

export const replaceLinesTool: ToolDefinition = {
  name: "replaceLines",
  description:
    "Replace a 1-based line range in a workspace file. Safer than exact text anchors when line numbers are known from readFile.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      startLine: { type: "number", description: "1-based first line to replace." },
      lineCount: { type: "number", description: "Number of lines to replace." },
      content: { type: "string", description: "Replacement text." }
    },
    required: ["path", "startLine", "lineCount", "content"]
  },
  async run(input, ctx) {
    const args = lineRangeEditSchema.parse(input);
    const filePath = resolveInsideCwd(ctx.cwd, args.path);
    const content = await readFile(filePath, "utf8");
    const lines = splitLinesForEdit(content);
    if (args.startLine > lines.length) {
      return {
        ok: false,
        content: `Line ${args.startLine} is outside ${args.path}, which has ${lines.length} lines.`,
        errorCode: "LINE_OUT_OF_RANGE",
        retryable: true,
        metadata: { path: args.path, startLine: args.startLine, totalLines: lines.length }
      };
    }
    const replacement = args.content.replace(/\r?\n$/, "").split(/\r?\n/);
    lines.splice(args.startLine - 1, args.lineCount, ...replacement);
    await writeFile(filePath, joinLinesForEdit(lines, content), "utf8");
    return toolSuccess(`Replaced ${args.lineCount} line(s) in ${args.path}.`, {
      path: args.path,
      startLine: args.startLine,
      lineCount: args.lineCount
    });
  }
};

export const insertAtLineTool: ToolDefinition = {
  name: "insertAtLine",
  description: "Insert text before a 1-based line number in a workspace file. Use line=totalLines+1 to append.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      line: { type: "number", description: "1-based line number; insert before this line." },
      content: { type: "string", description: "Text to insert." }
    },
    required: ["path", "line", "content"]
  },
  async run(input, ctx) {
    const args = insertAtLineSchema.parse(input);
    const filePath = resolveInsideCwd(ctx.cwd, args.path);
    const content = await readFile(filePath, "utf8");
    const lines = splitLinesForEdit(content);
    if (args.line > lines.length + 1) {
      return {
        ok: false,
        content: `Line ${args.line} is outside ${args.path}, which has ${lines.length} lines.`,
        errorCode: "LINE_OUT_OF_RANGE",
        retryable: true,
        metadata: { path: args.path, line: args.line, totalLines: lines.length }
      };
    }
    const insertion = args.content.replace(/\r?\n$/, "").split(/\r?\n/);
    lines.splice(args.line - 1, 0, ...insertion);
    await writeFile(filePath, joinLinesForEdit(lines, content), "utf8");
    return toolSuccess(`Inserted ${args.content.length} chars into ${args.path}.`, {
      path: args.path,
      line: args.line
    });
  }
};

export const readTailTool: ToolDefinition = {
  name: "readTail",
  description: "Read the last N lines of a UTF-8 text file from the workspace.",
  sideEffect: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      lineCount: { type: "number", default: 80 }
    },
    required: ["path"]
  },
  async run(input, ctx) {
    const args = readTailSchema.parse(input);
    const filePath = resolveInsideCwd(ctx.cwd, args.path);
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    const startLine = Math.max(1, totalLines - args.lineCount + 1);
    const range = sliceLines(content, startLine, args.lineCount, toProjectRelative(ctx.cwd, filePath));
    return toolSuccess(range.content, {
      path: args.path,
      totalLines,
      startLine: range.startLine,
      endLine: range.endLine,
      lineCount: args.lineCount
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
