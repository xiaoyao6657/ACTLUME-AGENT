import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  assessFinalCompletion,
  isShellEnvironmentSetupCommand,
  isShellVerificationCommand,
  maybeBlockByStageBudget,
  parseAgentOutput,
  shouldRequireEditsBeforeFinal
} from "../src/agent.js";
import type { EditWorkflowState } from "../src/edit-workflow.js";
import type { AgentActionOutput, AgentHistoryItem, ToolResult } from "../src/types.js";

type RunLogEvent = {
  event?: string;
  step?: number;
  data?: Record<string, unknown>;
};

type ReplayStep = {
  step: number;
  tool: string;
  simulatedResult: "ok" | "blocked" | "failed";
  errorCode?: string;
  note?: string;
};

const logPath = process.argv[2];
if (!logPath) {
  console.error("Usage: tsx scripts/replay-run.ts <run.jsonl>");
  process.exit(2);
}

const raw = await readFile(logPath, "utf8");
const events = raw
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as RunLogEvent);

const userTask = extractUserTask(events);
const maxSteps = Math.max(...events.map((event) => event.step ?? 0), 1);
const runId = basename(logPath, ".jsonl");
const cwd = dirname(dirname(dirname(logPath)));
const workflow: EditWorkflowState = {
  runId,
  changedFiles: [],
  checks: []
};
const history: AgentHistoryItem[] = [];
const replaySteps: ReplayStep[] = [];
let finalStatus: "completed" | "failed" | "max_steps" | "none" = "none";
let eventSequence = 0;

function nextReplayTimestamp(): string {
  eventSequence += 1;
  const mins = String(Math.floor(eventSequence / 60)).padStart(2, "0");
  const secs = String(eventSequence % 60).padStart(2, "0");
  return `2026-01-01T00:${mins}:${secs}.000Z`;
}
let finalAssessment: ReturnType<typeof assessFinalCompletion> | undefined;

for (const event of events) {
  if (event.event === "run_end") {
    const data = event.data ?? {};
    const status = typeof data.status === "string" ? data.status : "none";
    finalStatus = status === "completed" || status === "failed" || status === "max_steps" ? status : "none";
  }

  if (event.event !== "llm_response") {
    continue;
  }

  const step = event.step ?? 0;
  const response = event.data?.raw;
  if (typeof response !== "string") {
    continue;
  }

  const parsed = parseAgentOutput(response);
  if (!parsed.ok) {
    const observation = `Invalid agent JSON output during replay: ${parsed.error}`;
    history.push({
      thought: "Replay parse failure",
      action: { type: "action", thought: "Replay parse failure", tool: "none", input: {} },
      observation
    });
    replaySteps.push({ step, tool: "RAW", simulatedResult: "failed", errorCode: "PARSE_ERROR", note: parsed.error });
    continue;
  }

  if (parsed.value.type === "final") {
    finalAssessment = assessFinalCompletion(userTask, parsed.value.answer, workflow);
    replaySteps.push({
      step,
      tool: "final",
      simulatedResult: finalAssessment.ok ? "ok" : "failed",
      errorCode: finalAssessment.ok ? undefined : "FINAL_ASSESSMENT_FAILED",
      note: finalAssessment.ok ? "final accepted by current completion rules" : finalAssessment.message
    });
    continue;
  }

  const action = parsed.value;
  const blocked = maybeBlockByStageBudget(action, userTask, step, maxSteps, workflow, history);
  const result = blocked ?? inferToolResultFromRecordedLog(events, step);
  applyWorkflowEffect(workflow, action, result);
  history.push({
    thought: action.thought,
    action,
    observation: formatReplayObservation(result)
  });
  replaySteps.push({
    step,
    tool: action.tool,
    simulatedResult: result.ok ? "ok" : blocked ? "blocked" : "failed",
    errorCode: result.ok ? undefined : result.errorCode,
    note: summarize(result.content)
  });
}

printSummary();

function extractUserTask(logEvents: RunLogEvent[]): string {
  const firstTurn = logEvents.find((event) => event.event === "turn_start");
  const prompt = firstTurn?.data?.prompt;
  if (typeof prompt !== "string") {
    return "";
  }
  const match = /User task:\n([\s\S]*?)\n\nModel context:/.exec(prompt);
  return match?.[1]?.trim() ?? "";
}

function inferToolResultFromRecordedLog(logEvents: RunLogEvent[], step: number): ToolResult {
  const resultEvent = logEvents.find((event) => event.event === "tool_result" && event.step === step);
  const toolResult = (resultEvent?.data?.toolResult ?? undefined) as ToolResult | undefined;
  if (toolResult && typeof toolResult === "object" && "ok" in toolResult) {
    return toolResult;
  }
  return { ok: true, content: "Replay assumed success because no tool_result was found." };
}

function applyWorkflowEffect(workflow: EditWorkflowState, action: AgentActionOutput, result: ToolResult): void {
  if (action.tool === "editPlan" && result.ok && action.input && typeof action.input === "object") {
    const input = action.input as Record<string, unknown>;
    workflow.plan = {
      summary: typeof input.summary === "string" ? input.summary : "Replay plan",
      expectedFiles: Array.isArray(input.expectedFiles) ? input.expectedFiles.filter((item): item is string => typeof item === "string") : [],
      steps: Array.isArray(input.steps) ? input.steps.filter((item): item is string => typeof item === "string") : [],
      createdAt: new Date(0).toISOString()
    };
  }

  if (result.ok && isEditTool(action.tool)) {
    for (const path of extractActionPaths(action)) {
      workflow.changedFiles.push({ path, tool: action.tool, timestamp: nextReplayTimestamp() });
    }
  }

  if (action.tool === "shell") {
    const command = extractShellCommand(action);
    if (command && looksLikeVerification(command)) {
      workflow.checks.push({
        command,
        ok: result.ok,
        errorCode: result.ok ? undefined : result.errorCode,
        timestamp: nextReplayTimestamp()
      });
    }
  }
}

function isEditTool(tool: string): boolean {
  return new Set(["writeFile", "appendFile", "appendToFile", "replaceText", "insertText", "replaceLines", "insertAtLine", "applyPatch"]).has(tool);
}

function extractActionPaths(action: AgentActionOutput): string[] {
  if (!action.input || typeof action.input !== "object") {
    return [];
  }
  const input = action.input as Record<string, unknown>;
  if (typeof input.path === "string") {
    return [input.path];
  }
  if (typeof input.patch === "string") {
    return [...input.patch.matchAll(/^\+\+\+\s+b\/(.+)$/gm)].map((match) => match[1]).filter((path) => path !== "/dev/null");
  }
  return [];
}

function extractShellCommand(action: AgentActionOutput): string | undefined {
  if (!action.input || typeof action.input !== "object") {
    return undefined;
  }
  const command = (action.input as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

function looksLikeVerification(command: string): boolean {
  if (isShellEnvironmentSetupCommand(command)) {
    return false;
  }
  return isShellVerificationCommand(command);
}

function formatReplayObservation(result: ToolResult): string {
  if (result.ok) {
    return result.content;
  }
  return `[tool_error]\ncode: ${result.errorCode}\nmessage:\n${result.content}`;
}

function summarize(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 220);
}

function printSummary(): void {
  const blocked = replaySteps.filter((step) => step.simulatedResult === "blocked");
  const failed = replaySteps.filter((step) => step.simulatedResult === "failed");
  console.log(`[replay] ${logPath}`);
  console.log(`task: ${summarize(userTask)}`);
  console.log(`recordedStatus: ${finalStatus}`);
  console.log(`steps: ${replaySteps.length}`);
  console.log(`blockedByCurrentPolicy: ${blocked.length}`);
  console.log(`failedActions: ${failed.length}`);
  if (finalAssessment && !finalAssessment.ok) {
    console.log("finalAssessment: failed");
    for (const reason of finalAssessment.reasons) {
      console.log(`- ${reason}`);
    }
  } else if (finalAssessment?.ok) {
    console.log("finalAssessment: ok");
  }
  console.log("\nstep report:");
  for (const item of replaySteps) {
    const code = item.errorCode ? ` ${item.errorCode}` : "";
    const note = item.note ? ` - ${item.note}` : "";
    console.log(`${String(item.step).padStart(2, " ")} ${item.tool} ${item.simulatedResult}${code}${note}`);
  }
  console.log(`\nreplayCwd: ${cwd}`);
  if (shouldRequireEditsBeforeFinal(userTask, workflow)) {
    console.log("note: current workflow still requires edits before final.");
  }
}
