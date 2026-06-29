import { spawn } from "node:child_process";
import { z } from "zod";
import { ActionStore } from "./action-store.js";
import { compactHistoryForPrompt } from "./context-policy.js";
import { getContextBudget } from "./context-budget.js";
import {
  EditWorkflowStore,
  extractShellCommand,
  formatEditWorkflowSummary,
  isShellCheckCommand,
  pickCheckCommand,
  requiresEditPlan,
  type EditWorkflowState
} from "./edit-workflow.js";
import { callLLM } from "./llm.js";
import { formatProjectScan, scanProjectWithCache } from "./project-scan.js";
import { RunLogger } from "./run-log.js";
import { summarizeObservation } from "./summary.js";
import { formatToolResultForObservation, toolFailure } from "./tool-result.js";
import { buildToolConfirmationRequest } from "./tool-preview.js";
import { runRegisteredTool } from "./tool-scheduler.js";
import type {
  AgentActionOutput,
  AgentFinalOutput,
  AgentHistoryItem,
  AgentOutput,
  ToolConfirmationRequest,
  ToolContext,
  ToolDefinition,
  ToolResult
} from "./types.js";
import { getToolDescriptions, tools as localTools } from "./tools/registry.js";

export type RunAgentOptions = {
  userTask: string;
  cwd?: string;
  memoryDir?: string;
  maxSteps?: number;
  readonly?: boolean;
  runId?: string;
  model?: string;
  tools?: ToolDefinition[];
  autoConfirm?: boolean;
  confirmToolCall?: (request: ToolConfirmationRequest) => Promise<boolean>;
};

export type RunAgentResult = {
  answer: string;
  status: "completed" | "failed" | "max_steps";
  runId: string;
  logPath: string;
  stepsUsed: number;
  toolCalls: number;
};

type ProjectContextInfo = {
  text: string;
  suggestedChecks: string[];
};

const actionSchema = z.object({
  type: z.literal("action"),
  thought: z.string(),
  tool: z.string(),
  input: z.unknown()
});

const finalSchema = z.object({
  type: z.literal("final"),
  answer: z.string()
});

const agentOutputSchema = z.union([actionSchema, finalSchema]);

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const cwd = options.cwd ?? process.cwd();
  const memoryDir = options.memoryDir ?? process.env.AGENT_MEMORY_DIR ?? ".agent-memory";
  const maxSteps = options.maxSteps ?? Number(process.env.AGENT_MAX_STEPS ?? 10);
  const runId = options.runId ?? crypto.randomUUID();
  const ctx: ToolContext = { cwd, memoryDir, readonly: options.readonly ?? false, runId };
  const availableTools = options.tools ?? localTools;
  const actionStore = new ActionStore(memoryDir);
  const logger = new RunLogger(memoryDir, runId);
  const editWorkflow = new EditWorkflowStore(memoryDir, runId);
  await editWorkflow.reset();
  const projectContext = await buildProjectContext(cwd, memoryDir);
  const history: AgentHistoryItem[] = [];
  let invalidJsonRetries = 0;
  let autoRepairAttempts = 0;
  let stepsUsed = 0;
  let toolCalls = 0;

  await logger.write({
    event: "run_start",
    data: {
      userTask: options.userTask,
      cwd,
      memoryDir,
      maxSteps,
      readonly: ctx.readonly,
      model: options.model,
      projectContext: projectContext.text
    }
  });

  for (let step = 1; step <= maxSteps; step += 1) {
    stepsUsed = step;
    const prompt = buildPrompt(options.userTask, history, availableTools, projectContext.text);
    await logger.write({ event: "turn_start", step, data: { prompt } });
    console.log(`\n[turn ${step}] LLM`);
    const raw = await callLLM(prompt, { model: options.model });
    await logger.write({ event: "llm_response", step, data: { raw } });
    const parsed = parseAgentOutput(raw);

    if (!parsed.ok) {
      invalidJsonRetries += 1;
      const observation = `Invalid agent JSON output: ${parsed.error}. Raw output: ${raw.slice(0, 1000)}`;
      console.log(`[observation]\n${observation}`);
      await logger.write({ event: "parse_error", step, data: { error: parsed.error, observation } });

      if (invalidJsonRetries > 2) {
        const answer = `Stopped after repeated invalid JSON output. Last error: ${parsed.error}`;
        await logger.write({ event: "run_end", data: { status: "failed", answer } });
        return {
          answer,
          status: "failed",
          runId: logger.runId,
          logPath: logger.filePath,
          stepsUsed,
          toolCalls
        };
      }

      history.push({
        thought: "The model returned invalid JSON and must retry with the protocol.",
        action: {
          type: "action",
          thought: "Protocol repair",
          tool: "none",
          input: {}
        },
        observation
      });
      continue;
    }

    invalidJsonRetries = 0;
    if (parsed.value.type === "final") {
      const completion = await completeEditWorkflow({
        availableTools,
        actionStore,
        editWorkflow,
        projectContext,
        ctx,
        options,
        logger,
        step,
        canRepair: autoRepairAttempts < 1 && step < maxSteps
      });
      toolCalls += completion.toolCalls;

      if (completion.repairObservation) {
        autoRepairAttempts += 1;
        history.push({
          thought: "Automatic project check failed; the agent should inspect the failure and repair once.",
          action: completion.action,
          observation: completion.repairObservation
        });
        continue;
      }

      const answer = appendWorkflowSummary(parsed.value.answer, completion.workflowState, completion.gitDiffSummary);
      console.log("Final:");
      console.log(answer);
      await logger.write({ event: "final", step, data: { answer } });
      await logger.write({ event: "run_end", data: { status: "completed", answer } });
      return {
        answer,
        status: "completed",
        runId: logger.runId,
        logPath: logger.filePath,
        stepsUsed,
        toolCalls
      };
    }

    const action = parsed.value;
    toolCalls += 1;
    console.log(`Thought: ${action.thought}`);
    console.log(`Action: ${action.tool} ${JSON.stringify(action.input)}`);

    const toolResult = await maybeConfirmAndRunTool(availableTools, action, ctx, options, editWorkflow);
    const observation = formatToolResultForObservation(toolResult);
    const compactObservation = summarizeObservation(observation);
    console.log("[observation]");
    console.log(compactObservation);
    await logger.write({ event: "tool_result", step, data: { action, toolResult, observation } });

    await actionStore.save({
      thought: action.thought,
      toolName: action.tool,
      toolInput: action.input,
      toolResult,
      observation,
      summary: compactObservation
    });

    await recordEditWorkflowEffect(editWorkflow, action, toolResult, projectContext.suggestedChecks);

    history.push({
      thought: action.thought,
      action,
      observation
    });
  }

  const answer = `Reached max steps (${maxSteps}); task may be incomplete.`;
  await logger.write({ event: "run_end", data: { status: "max_steps", answer } });
  return {
    answer,
    status: "max_steps",
    runId: logger.runId,
    logPath: logger.filePath,
    stepsUsed,
    toolCalls
  };
}

async function maybeConfirmAndRunTool(
  availableTools: ToolDefinition[],
  action: AgentActionOutput,
  ctx: ToolContext,
  options: RunAgentOptions,
  editWorkflow: EditWorkflowStore
): Promise<ToolResult> {
  const tool = availableTools.find((item) => item.name === action.tool);
  if (tool && requiresEditPlan(action.tool)) {
    const workflow = await editWorkflow.get();
    if (!workflow.plan) {
      return toolFailure({
        content:
          "Workspace file edits require an edit plan first. Call editPlan with a concise summary, expectedFiles, and steps before retrying this edit.",
        errorCode: "EDIT_PLAN_REQUIRED",
        retryable: true,
        metadata: { toolName: action.tool }
      });
    }
  }

  if (!tool || tool.sideEffect === "read" || ctx.readonly || options.autoConfirm) {
    return runRegisteredTool(availableTools, action.tool, action.input, ctx);
  }

  const request = await buildToolConfirmationRequest(tool, action.input, ctx);
  const approved = options.confirmToolCall ? await options.confirmToolCall(request) : false;
  if (!approved) {
    return {
      ok: false,
      content: `User rejected tool call ${tool.name}.`,
      errorCode: "CONFIRMATION_REJECTED",
      retryable: false,
      metadata: request
    };
  }

  return runRegisteredTool(availableTools, action.tool, action.input, ctx);
}

async function buildProjectContext(cwd: string, memoryDir: string): Promise<ProjectContextInfo> {
  try {
    const result = await scanProjectWithCache(cwd, { maxDepth: 3, maxFiles: 250, memoryDir });
    const text = [
      `Project index cache: ${result.cacheHit ? "hit" : "miss"}`,
      `Project summary: ${result.summaryPath ?? "<not persisted>"}`,
      formatProjectScan(result.scan)
    ].join("\n");
    return { text, suggestedChecks: result.scan.suggestedChecks };
  } catch (error) {
    return { text: `Project scan failed: ${(error as Error).message}`, suggestedChecks: [] };
  }
}

async function recordEditWorkflowEffect(
  editWorkflow: EditWorkflowStore,
  action: AgentActionOutput,
  toolResult: ToolResult,
  suggestedChecks: string[]
): Promise<void> {
  await editWorkflow.recordChangedFiles(action, toolResult);

  if (action.tool !== "shell") {
    return;
  }

  const command = extractShellCommand(action.input);
  if (command && isShellCheckCommand(command, suggestedChecks)) {
    await editWorkflow.recordCheck(command, toolResult);
  }
}

async function completeEditWorkflow(params: {
  availableTools: ToolDefinition[];
  actionStore: ActionStore;
  editWorkflow: EditWorkflowStore;
  projectContext: ProjectContextInfo;
  ctx: ToolContext;
  options: RunAgentOptions;
  logger: RunLogger;
  step: number;
  canRepair: boolean;
}): Promise<{
  workflowState: EditWorkflowState;
  gitDiffSummary?: string;
  repairObservation?: string;
  action: AgentActionOutput;
  toolCalls: number;
}> {
  let workflowState = await params.editWorkflow.get();
  let toolCalls = 0;
  const fallbackAction: AgentActionOutput = {
    type: "action",
    thought: "No automatic workflow action was needed.",
    tool: "none",
    input: {}
  };

  if (workflowState.changedFiles.length > 0 && !hasCheckAfterLatestChange(workflowState)) {
    const command = pickCheckCommand(params.projectContext.suggestedChecks);
    if (command) {
      const action: AgentActionOutput = {
        type: "action",
        thought: "Run the project check automatically after workspace edits.",
        tool: "shell",
        input: { command, timeoutMs: 120000 }
      };
      toolCalls += 1;
      await params.logger.write({ event: "auto_check_start", step: params.step, data: { action } });
      const toolResult = await maybeConfirmAndRunTool(
        params.availableTools,
        action,
        params.ctx,
        params.options,
        params.editWorkflow
      );
      const observation = formatToolResultForObservation(toolResult);
      await params.logger.write({ event: "auto_check_result", step: params.step, data: { action, toolResult, observation } });
      await params.actionStore.save({
        thought: action.thought,
        toolName: action.tool,
        toolInput: action.input,
        toolResult,
        observation,
        summary: summarizeObservation(observation)
      });
      await recordEditWorkflowEffect(params.editWorkflow, action, toolResult, params.projectContext.suggestedChecks);
      workflowState = await params.editWorkflow.get();

      if (!toolResult.ok && toolResult.errorCode !== "CONFIRMATION_REJECTED" && params.canRepair) {
        return {
          workflowState,
          repairObservation: `Automatic check failed after edits.\nCommand: ${command}\nObservation:\n${observation}\nPlease inspect the failure, make a focused repair, and finish again.`,
          action,
          toolCalls
        };
      }
    }
  }

  const latestCheck = latestCheckAfterLatestChange(workflowState);
  if (latestCheck && !latestCheck.ok && params.canRepair) {
    return {
      workflowState,
      repairObservation: `Latest project check failed after edits.\nCommand: ${latestCheck.command}\nError code: ${
        latestCheck.errorCode ?? "unknown"
      }\nPlease inspect the failure, make a focused repair, and finish again.`,
      action: {
        type: "action",
        thought: "The latest project check failed; the agent should repair once.",
        tool: "shell",
        input: { command: latestCheck.command }
      },
      toolCalls
    };
  }

  return {
    workflowState,
    gitDiffSummary: await getGitDiffSummary(params.ctx.cwd),
    action: fallbackAction,
    toolCalls
  };
}

function hasCheckAfterLatestChange(state: EditWorkflowState): boolean {
  return latestCheckAfterLatestChange(state) !== undefined;
}

function latestCheckAfterLatestChange(state: EditWorkflowState): EditWorkflowState["checks"][number] | undefined {
  if (state.changedFiles.length === 0) {
    return undefined;
  }
  const latestChange = Math.max(...state.changedFiles.map((item) => Date.parse(item.timestamp)));
  return state.checks
    .filter((item) => Date.parse(item.timestamp) >= latestChange)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
}

function appendWorkflowSummary(answer: string, state: EditWorkflowState, gitDiffSummary?: string): string {
  if (!state.plan && state.changedFiles.length === 0 && state.checks.length === 0) {
    return answer;
  }
  return `${answer}\n${formatEditWorkflowSummary(state, gitDiffSummary)}`;
}

async function getGitDiffSummary(cwd: string): Promise<string | undefined> {
  const [status, diffStat] = await Promise.all([
    runGit(["status", "--short"], cwd),
    runGit(["diff", "--stat", "--"], cwd)
  ]);
  const parts = [];
  if (status.exitCode === 0 && status.stdout.trim()) {
    parts.push("git status --short:", status.stdout.trim());
  }
  if (diffStat.exitCode === 0 && diffStat.stdout.trim()) {
    parts.push("git diff --stat:", diffStat.stdout.trim());
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
  });
}

function buildPrompt(
  userTask: string,
  history: AgentHistoryItem[],
  availableTools: ToolDefinition[],
  projectContext: string
): string {
  const compactHistory = compactHistoryForPrompt(history);
  const historyText =
    compactHistory.length === 0
      ? "No prior turns."
      : compactHistory
          .map(
            (item, index) => `Turn ${index + 1}
Thought: ${item.thought}
Action: ${item.action.tool} ${JSON.stringify(item.action.input)}
Observation:
${summarizeObservation(item.observation)}`
          )
          .join("\n\n");

  const parts = [
    `User task:\n${userTask}`,
    `Project context:\n${projectContext}`,
    `Available tools:\n${getToolDescriptions(availableTools)}`,
    `History:\n${historyText}`
  ];
  const budget = getContextBudget(parts);

  return `${parts.join("\n\n")}

Context budget estimate:
${JSON.stringify(budget)}

Protocol:
- Think step by step internally, but only output strict JSON.
- For coding tasks, inspect the relevant files before editing.
- Before writeFile, appendFile, or applyPatch, call editPlan with the planned change, expectedFiles, and steps.
- Prefer applyPatch for small code edits; use writeFile only when replacing or creating a whole file is appropriate.
- For multi-step coding tasks, use taskAdd/taskList/taskUpdate to track progress when helpful.
- After edits, the CLI may automatically run a suggested project check and ask you to repair once if it fails.
- If a write or execute tool is rejected by confirmation, explain what would be needed or choose a read-only alternative.
- After edits, run a suitable check command when available.
- To call a tool, output:
{"type":"action","thought":"why this tool is needed","tool":"toolName","input":{}}
- To finish, output:
{"type":"final","answer":"final answer for the user"}
- Do not output Markdown fences, comments, or extra text outside JSON.
`;
}

function parseAgentOutput(raw: string): { ok: true; value: AgentOutput } | { ok: false; error: string } {
  try {
    const clean = stripJsonFence(raw.trim());
    const parsed = JSON.parse(clean) as unknown;
    return { ok: true, value: agentOutputSchema.parse(parsed) as AgentActionOutput | AgentFinalOutput };
  } catch (error) {
    const candidate = extractFirstJsonObject(raw);
    if (candidate) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        return { ok: true, value: agentOutputSchema.parse(parsed) as AgentActionOutput | AgentFinalOutput };
      } catch {
        // Return the original error because it usually points to the protocol violation more clearly.
      }
    }

    return { ok: false, error: (error as Error).message };
  }
}

function stripJsonFence(text: string): string {
  if (!text.startsWith("```")) {
    return text;
  }
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}
