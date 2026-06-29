import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentActionOutput, ToolResult } from "./types.js";

export type EditPlan = {
  summary: string;
  expectedFiles: string[];
  steps: string[];
  createdAt: string;
};

export type ChangedFileRecord = {
  path: string;
  tool: string;
  timestamp: string;
};

export type CheckRecord = {
  command: string;
  ok: boolean;
  errorCode?: string;
  timestamp: string;
};

export type EditWorkflowState = {
  runId: string;
  plan?: EditPlan;
  changedFiles: ChangedFileRecord[];
  checks: CheckRecord[];
};

const fileEditTools = new Set(["writeFile", "appendFile", "applyPatch"]);

export class EditWorkflowStore {
  readonly filePath: string;

  constructor(
    private readonly memoryDir: string,
    private readonly runId: string
  ) {
    this.filePath = join(memoryDir, "edit-workflow.json");
  }

  async reset(): Promise<EditWorkflowState> {
    const state: EditWorkflowState = {
      runId: this.runId,
      changedFiles: [],
      checks: []
    };
    await this.write(state);
    return state;
  }

  async get(): Promise<EditWorkflowState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as EditWorkflowState;
      if (parsed.runId === this.runId) {
        return {
          runId: parsed.runId,
          plan: parsed.plan,
          changedFiles: parsed.changedFiles ?? [],
          checks: parsed.checks ?? []
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    return this.reset();
  }

  async setPlan(plan: Omit<EditPlan, "createdAt">): Promise<EditWorkflowState> {
    const state = await this.get();
    state.plan = { ...plan, createdAt: new Date().toISOString() };
    await this.write(state);
    return state;
  }

  async recordChangedFiles(action: AgentActionOutput, result: ToolResult): Promise<void> {
    if (!result.ok || !fileEditTools.has(action.tool)) {
      return;
    }

    const paths = extractChangedFiles(action);
    if (paths.length === 0) {
      return;
    }

    const state = await this.get();
    const seen = new Set(state.changedFiles.map((item) => `${item.path}\0${item.tool}`));
    for (const path of paths) {
      const key = `${path}\0${action.tool}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      state.changedFiles.push({
        path,
        tool: action.tool,
        timestamp: new Date().toISOString()
      });
    }
    await this.write(state);
  }

  async recordCheck(command: string, result: ToolResult): Promise<void> {
    const state = await this.get();
    state.checks.push({
      command,
      ok: result.ok,
      errorCode: result.ok ? undefined : result.errorCode,
      timestamp: new Date().toISOString()
    });
    await this.write(state);
  }

  private async write(state: EditWorkflowState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}

export function requiresEditPlan(toolName: string): boolean {
  return fileEditTools.has(toolName);
}

export function isShellCheckCommand(command: string, suggestedChecks: string[]): boolean {
  const normalized = command.trim().toLowerCase();
  if (suggestedChecks.some((item) => item.trim().toLowerCase() === normalized)) {
    return true;
  }
  return /\b(typecheck|test|lint|build|benchmark|pytest|cargo test|go test)\b/i.test(command);
}

export function pickCheckCommand(suggestedChecks: string[]): string | undefined {
  return suggestedChecks[0];
}

export function formatEditWorkflowSummary(state: EditWorkflowState, gitDiffSummary?: string): string {
  const lines = ["", "Edit workflow summary:"];
  if (state.plan) {
    lines.push(`- Plan: ${state.plan.summary}`);
    lines.push(
      `- Expected files: ${state.plan.expectedFiles.length === 0 ? "none listed" : state.plan.expectedFiles.join(", ")}`
    );
  } else {
    lines.push("- Plan: none");
  }

  lines.push(
    `- Changed files: ${
      state.changedFiles.length === 0
        ? "none"
        : state.changedFiles.map((item) => `${item.path} (${item.tool})`).join(", ")
    }`
  );

  if (state.checks.length === 0) {
    lines.push("- Checks: none run");
  } else {
    lines.push(
      `- Checks: ${state.checks
        .map((item) => `${item.command}: ${item.ok ? "passed" : `failed ${item.errorCode ?? ""}`.trim()}`)
        .join("; ")}`
    );
  }

  if (gitDiffSummary) {
    lines.push("- Diff summary:");
    lines.push(gitDiffSummary);
  }

  return lines.join("\n");
}

export function extractShellCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("command" in input)) {
    return undefined;
  }

  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

function extractChangedFiles(action: AgentActionOutput): string[] {
  if (action.tool === "writeFile" || action.tool === "appendFile") {
    return extractPathInput(action.input);
  }

  if (action.tool === "applyPatch") {
    return extractPatchFiles(action.input);
  }

  return [];
}

function extractPathInput(input: unknown): string[] {
  if (!input || typeof input !== "object" || !("path" in input)) {
    return [];
  }

  const path = (input as Record<string, unknown>).path;
  return typeof path === "string" ? [path] : [];
}

function extractPatchFiles(input: unknown): string[] {
  if (!input || typeof input !== "object" || !("patch" in input)) {
    return [];
  }

  const patch = (input as Record<string, unknown>).patch;
  if (typeof patch !== "string") {
    return [];
  }

  const files = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      files.add(line.slice("+++ b/".length));
    } else if (line.startsWith("--- a/")) {
      files.add(line.slice("--- a/".length));
    }
  }
  files.delete("/dev/null");
  return [...files].filter((file) => file !== "/dev/null");
}
