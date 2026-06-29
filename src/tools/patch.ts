import { spawn } from "node:child_process";
import { z } from "zod";
import { toolFailure, toolSuccess } from "../tool-result.js";
import type { ToolDefinition } from "../types.js";

const applyPatchSchema = z.object({
  patch: z.string().min(1),
  checkOnly: z.boolean().default(false)
});

export const applyPatchTool: ToolDefinition = {
  name: "applyPatch",
  description:
    "Apply a unified diff patch in the workspace using git apply. Prefer this for small code edits instead of rewriting whole files.",
  sideEffect: "write",
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "Unified diff patch text." },
      checkOnly: { type: "boolean", default: false }
    },
    required: ["patch"]
  },
  async run(input, ctx) {
    const args = applyPatchSchema.parse(input);
    const check = await runGitApply(ctx.cwd, ["apply", "--check", "--whitespace=nowarn", "-"], args.patch);
    if (check.exitCode !== 0) {
      return toolFailure({
        content: `Patch check failed.\nstdout:\n${check.stdout}\nstderr:\n${check.stderr}`,
        errorCode: "PATCH_CHECK_FAILED",
        retryable: true,
        metadata: check
      });
    }

    if (args.checkOnly) {
      return toolSuccess("Patch check passed; no files changed.", check);
    }

    const applied = await runGitApply(ctx.cwd, ["apply", "--whitespace=nowarn", "-"], args.patch);
    if (applied.exitCode !== 0) {
      return toolFailure({
        content: `Patch apply failed.\nstdout:\n${applied.stdout}\nstderr:\n${applied.stderr}`,
        errorCode: "PATCH_APPLY_FAILED",
        retryable: true,
        metadata: applied
      });
    }

    return toolSuccess("Patch applied successfully.", applied);
  }
};

async function runGitApply(
  cwd: string,
  args: string[],
  patch: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ stdout, stderr: `${stderr}${error.message}`, exitCode: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.end(patch);
  });
}
