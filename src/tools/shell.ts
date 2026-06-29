import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ShellResult, ToolDefinition } from "../types.js";
import { toolFailure, toolSuccess } from "../tool-result.js";
import { resolveInsideCwd } from "./path-utils.js";

const execAsync = promisify(exec);

const shellSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().default("."),
  timeoutMs: z.number().int().min(1000).max(120000).default(60000)
});

const forbiddenPatterns = [
  /\brm\s+-rf\s+[/.~]?/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bdel\s+\/[fsq]/i,
  /(^|[;&|]\s*)format(\s|$)/i,
  />\s*\/dev\/sd[a-z]/i
];

export const shellTool: ToolDefinition = {
  name: "shell",
  description: "Run a controlled shell command in the workspace and return stdout, stderr, and exit code.",
  sideEffect: "execute",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string", default: "." },
      timeoutMs: { type: "number", default: 60000 }
    },
    required: ["command"]
  },
  async run(input, ctx) {
    const args = shellSchema.parse(input);
    const workdir = resolveInsideCwd(ctx.cwd, args.cwd);
    if (forbiddenPatterns.some((pattern) => pattern.test(args.command))) {
      const result: ShellResult = {
        stdout: "",
        stderr: `Blocked potentially dangerous command: ${args.command}`,
        exitCode: 126
      };
      return toolFailure({
        content: JSON.stringify(result),
        errorCode: "SHELL_BLOCKED",
        retryable: false,
        metadata: { command: args.command, result }
      });
    }

    try {
      const result = await execAsync(args.command, {
        cwd: workdir,
        timeout: args.timeoutMs,
        maxBuffer: 1024 * 1024
      });
      const shellResult: ShellResult = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0
      };
      return toolSuccess(JSON.stringify(shellResult), { command: args.command, result: shellResult });
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
      const shellResult: ShellResult = {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: typeof err.code === "number" ? err.code : 1
      };
      return toolFailure({
        content: JSON.stringify(shellResult),
        errorCode: "SHELL_EXIT_NONZERO",
        retryable: true,
        metadata: { command: args.command, result: shellResult }
      });
    }
  }
};
