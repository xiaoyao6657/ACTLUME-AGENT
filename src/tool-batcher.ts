import { runRegisteredTool } from "./tool-scheduler.js";
import type { AgentActionOutput, ToolContext, ToolDefinition, ToolResult } from "./types.js";

export type ToolBatchResult = {
  action: AgentActionOutput;
  result: ToolResult;
};

const concurrencySafeToolNames = new Set([
  "projectScan",
  "glob",
  "listDir",
  "tree",
  "searchText",
  "readFile",
  "readTail",
  "fileExists",
  "readPlan",
  "memoryList",
  "memoryRecall",
  "recall",
  "skill",
  "taskList"
]);

export function isConcurrencySafeTool(tool: ToolDefinition | undefined): boolean {
  return Boolean(tool && tool.sideEffect === "read" && concurrencySafeToolNames.has(tool.name));
}

export async function runToolBatch(
  tools: ToolDefinition[],
  actions: AgentActionOutput[],
  ctx: ToolContext
): Promise<ToolBatchResult[]> {
  const lookup = new Map(tools.map((tool) => [tool.name, tool]));
  const batches = groupToolActions(actions, (action) => isConcurrencySafeTool(lookup.get(action.tool)));
  const results: ToolBatchResult[] = [];

  for (const batch of batches) {
    if (batch.concurrent) {
      const batchResults = await Promise.all(
        batch.actions.map(async (action) => ({
          action,
          result: await runRegisteredTool(tools, action.tool, action.input, ctx)
        }))
      );
      results.push(...batchResults);
      continue;
    }

    for (const action of batch.actions) {
      results.push({
        action,
        result: await runRegisteredTool(tools, action.tool, action.input, ctx)
      });
    }
  }

  return results;
}

function groupToolActions(
  actions: AgentActionOutput[],
  isSafe: (action: AgentActionOutput) => boolean
): Array<{ concurrent: boolean; actions: AgentActionOutput[] }> {
  const batches: Array<{ concurrent: boolean; actions: AgentActionOutput[] }> = [];
  for (const action of actions) {
    const safe = isSafe(action);
    const last = batches.at(-1);
    if (safe && last?.concurrent) {
      last.actions.push(action);
    } else {
      batches.push({ concurrent: safe, actions: [action] });
    }
  }
  return batches;
}
