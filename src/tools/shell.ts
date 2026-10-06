import { z } from "zod";
import { assessShellCommand } from "../security.js";
import type { ShellResult, ToolDefinition } from "../types.js";
import { toolFailure, toolSuccess } from "../tool-result.js";
import { runShellCommand } from "../process-supervisor.js";
import { resolveInsideCwd } from "./path-utils.js";

const shellSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().default("."),
  timeoutMs: z.number().int().min(1000).max(120000).default(60000)
});

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
    const windowsIssue = detectWindowsIncompatibleCommand(args.command);
    if (windowsIssue) {
      const result: ShellResult = {
        stdout: "",
        stderr: windowsIssue.message,
        exitCode: 127
      };
      return toolFailure({
        content: JSON.stringify(result),
        errorCode: "SHELL_WINDOWS_INCOMPATIBLE",
        retryable: true,
        metadata: { command: args.command, result, suggestion: windowsIssue.suggestion }
      });
    }

    const assessment = assessShellCommand(args.command, ctx.securityPolicy);
    if (!assessment.allowed) {
      const result: ShellResult = {
        stdout: "",
        stderr: `${assessment.reason ?? "Blocked shell command"}: ${args.command}`,
        exitCode: 126
      };
      return toolFailure({
        content: JSON.stringify(result),
        errorCode: assessment.errorCode ?? "SHELL_BLOCKED",
        retryable: false,
        metadata: { command: args.command, result, assessment }
      });
    }

    const execution = await runShellCommand({
      command: args.command,
      cwd: workdir,
      timeoutMs: args.timeoutMs,
      signal: ctx.signal
    });
    const shellResult: ShellResult = {
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
      outcome: execution.outcome,
      terminationConfirmed: execution.terminationConfirmed
    };
    const metadata = {
      command: args.command,
      cwd: execution.cwd,
      shell: execution.shell,
      durationMs: execution.durationMs,
      result: shellResult,
      assessment
    };
    if (execution.outcome === "completed" && execution.exitCode === 0) {
      return toolSuccess(JSON.stringify(shellResult), metadata);
    }
    const errorCode = execution.outcome === "cancelled"
      ? "SHELL_CANCELLED"
      : execution.outcome === "timed_out"
        ? "SHELL_TIMEOUT"
        : execution.outcome === "start_failed"
          ? "SHELL_START_FAILED"
          : execution.outcome === "unknown"
            ? "SHELL_TERMINATION_UNKNOWN"
            : "SHELL_EXIT_NONZERO";
    return toolFailure({
      content: JSON.stringify(shellResult),
      errorCode,
      retryable: execution.outcome === "failed" || execution.outcome === "start_failed",
      metadata
    });
  }
};

function detectWindowsIncompatibleCommand(command: string): { message: string; suggestion: string } | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  if (/(^|[|;&]\s*)tail(\s|$)/i.test(command)) {
    return {
      message: "The command uses Unix `tail`, but this shell runs through Windows cmd.exe.",
      suggestion: "Run the command without tail, or use a dedicated read tool such as readTail after writing output intentionally."
    };
  }

  if (/\b(select-object|select-string|out-file|set-content|get-content|where-object|foreach-object)\b/i.test(command)) {
    return {
      message: "The command uses PowerShell-only syntax, but this shell runs through Windows cmd.exe.",
      suggestion: "Use cmd-compatible syntax, run the command without filtering, or use dedicated read/edit tools instead."
    };
  }

  return undefined;
}
