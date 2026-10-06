import type { AgentActionOutput, AgentHistoryItem, ToolResult } from "./types.js";
import type { EditPlan, EditWorkflowState } from "./edit-workflow.js";
import { maybeBlockByStageBudget } from "./workflow-guard.js";
import { classifyVerificationCommand } from "./verification.js";
import { getPolicyRule, type PolicyConfig } from "./policy-config.js";

/** Run-local bridge state for legacy deterministic workflow policies. Never shared through memoryDir. */
export class PiRunWorkflow {
  readonly state: EditWorkflowState;
  readonly history: AgentHistoryItem[] = [];
  private requestSequence = 0;
  private readonly sequenceByToolCall = new Map<string, number>();
  private readonly orderedHistory: Array<{ sequence: number; item: AgentHistoryItem }> = [];

  constructor(readonly runId: string) {
    this.state = { runId, changedFiles: [], checks: [] };
  }

  snapshot(): PiRunWorkflowSnapshot {
    return {
      schemaVersion: 1,
      state: {
        runId: this.runId,
        plan: this.state.plan ? { ...this.state.plan, expectedFiles: [...this.state.plan.expectedFiles], steps: [...this.state.plan.steps] } : undefined,
        changedFiles: this.state.changedFiles.slice(-300).map((file) => ({ ...file })),
        checks: this.state.checks.slice(-100).map((check) => ({ ...check }))
      },
      history: this.history.slice(-300).map((item) => ({
        thought: "",
        action: {
          ...item.action,
          input: boundValue(item.action.input)
        },
        observation: typeof item.observation === "string" && item.observation.length > 6_000
          ? `${item.observation.slice(0, 6_000)}\n[history observation clipped]`
          : item.observation
      }))
    };
  }

  static fromSnapshot(runId: string, snapshot: PiRunWorkflowSnapshot): PiRunWorkflow {
    const restored = new PiRunWorkflow(runId);
    restored.state.plan = snapshot.state.plan
      ? { ...snapshot.state.plan, expectedFiles: [...snapshot.state.plan.expectedFiles], steps: [...snapshot.state.plan.steps] }
      : undefined;
    restored.state.changedFiles.push(...snapshot.state.changedFiles.slice(-300).map((file) => ({ ...file })));
    restored.state.checks.push(...snapshot.state.checks.slice(-100).map((check) => ({ ...check })));
    const history = snapshot.history.slice(-300);
    history.forEach((item, sequence) => {
      restored.orderedHistory.push({ sequence: sequence + 1, item });
    });
    restored.orderedHistory.sort((a, b) => a.sequence - b.sequence);
    restored.history.push(...restored.orderedHistory.map(({ item }) => item));
    restored.requestSequence = restored.history.length;
    return restored;
  }

  check(tool: string, input: unknown, userTask: string, maxSteps: number, toolCallId?: string, step = this.requestSequence + 1, policyConfig?: PolicyConfig): ToolResult | undefined {
    this.requestSequence += 1;
    if (toolCallId) this.sequenceByToolCall.set(toolCallId, this.requestSequence);
    const action = this.toAction(tool, input);
    return maybeBlockByStageBudget(action, userTask, step, maxSteps, this.state, this.history, {
      efficiencyEnabled: getPolicyRule(policyConfig, "actlume.workflow.efficiency").mode !== "disabled",
      taskSpecificEnabled: getPolicyRule(policyConfig, "actlume.task.scope-precheck").mode !== "disabled"
    });
  }

  record(tool: string, input: unknown, result: { isError: boolean; content?: string; details?: unknown }, toolCallId?: string): void {
    const action = this.toAction(tool, input);
    const details = isRecord(result.details) ? result.details : {};
    const errorCode = typeof details.errorCode === "string" ? details.errorCode : undefined;
    const content = typeof result.content === "string" ? result.content : "";
    const observation = [errorCode ? `errorCode: ${errorCode}` : "", content].filter(Boolean).join("\n");
    const sequence = toolCallId ? this.sequenceByToolCall.get(toolCallId) : undefined;
    this.orderedHistory.push({ sequence: sequence ?? ++this.requestSequence, item: { thought: "", action, observation } });
    this.orderedHistory.sort((a, b) => a.sequence - b.sequence);
    this.history.splice(0, this.history.length, ...this.orderedHistory.map(({ item }) => item));
    if (toolCallId) this.sequenceByToolCall.delete(toolCallId);

    if ((tool === "writePlan" || tool === "editPlan") && !result.isError) {
      const planInput = isRecord(input) ? input : {};
      const steps = Array.isArray(planInput.steps)
        ? planInput.steps.flatMap((step) => typeof step === "string"
          ? [step]
          : isRecord(step) && typeof step.title === "string" ? [step.title] : [])
        : [];
      this.state.plan = {
        summary: typeof planInput.summary === "string"
          ? planInput.summary
          : typeof planInput.title === "string" ? planInput.title : "Implementation plan",
        content: typeof planInput.content === "string" ? planInput.content.slice(0, 16_000) : undefined,
        expectedFiles: Array.isArray(planInput.expectedFiles)
          ? planInput.expectedFiles.filter((path): path is string => typeof path === "string").slice(0, 100)
          : [],
        steps,
        createdAt: new Date().toISOString()
      } satisfies EditPlan;
    }

    if (!result.isError && isFileEditTool(tool)) {
      const paths = extractPaths(tool, input);
      for (const path of paths) this.state.changedFiles.push({ path, tool, timestamp: new Date().toISOString() });
    }

    if (tool === "shell") {
      const command = isRecord(input) && typeof input.command === "string" ? input.command : undefined;
      const metadata = isRecord(details.metadata) ? details.metadata : {};
      const shellResult = isRecord(metadata.result) ? metadata.result : {};
      const exitCode = typeof shellResult.exitCode === "number" ? shellResult.exitCode : undefined;
      if (command && classifyVerificationCommand(command)) {
        this.state.checks.push({
          command,
          ok: !result.isError && exitCode === 0,
          errorCode,
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  private toAction(tool: string, input: unknown): AgentActionOutput {
    return {
      type: "action",
      thought: "",
      tool: tool === "writePlan" ? "editPlan" : tool,
      input
    };
  }
}

export type PiRunWorkflowSnapshot = {
  schemaVersion: 1;
  state: EditWorkflowState;
  history: AgentHistoryItem[];
};

function isFileEditTool(tool: string): boolean {
  return ["writeFile", "appendFile", "appendToFile", "replaceText", "insertText", "replaceLines", "insertAtLine", "applyPatch"].includes(tool);
}

function extractPaths(tool: string, input: unknown): string[] {
  if (!isRecord(input)) return [];
  if (tool === "applyPatch" && typeof input.patch === "string") {
    const paths = new Set<string>();
    for (const line of input.patch.split(/\r?\n/)) {
      if (line.startsWith("+++ b/")) paths.add(line.slice(6));
      else if (line.startsWith("--- a/")) paths.add(line.slice(6));
    }
    paths.delete("/dev/null");
    return [...paths];
  }
  return typeof input.path === "string" ? [input.path] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested value clipped]";
  if (typeof value === "string") {
    if (value.length <= 12_000) return value;
    return `${value.slice(0, 12_000)}\n[tool input clipped in task-state checkpoint]`;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => boundValue(entry, depth + 1));
  if (isRecord(value)) {
    const entries = Object.entries(value).slice(0, 100);
    return Object.fromEntries(entries.map(([key, entry]) => [key, boundValue(entry, depth + 1)]));
  }
  return value;
}
