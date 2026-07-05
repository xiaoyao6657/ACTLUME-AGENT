import type { ToolDefinition } from "./types.js";

export type SubAgentType = "explore" | "plan" | "general";

const readOnlyTools = new Set([
  "projectScan",
  "glob",
  "listDir",
  "tree",
  "searchText",
  "readFile",
  "readTail",
  "fileExists",
  "readPlan",
  "skill",
  "recall",
  "taskList",
  "memoryList",
  "memoryRecall"
]);

export function normalizeSubAgentType(value: unknown): SubAgentType {
  return value === "explore" || value === "plan" || value === "general" ? value : "general";
}

export function getSubAgentSystemPrompt(type: SubAgentType): string {
  if (type === "explore") {
    return [
      "You are an explore sub-agent.",
      "Stay read-only. Search and inspect the codebase efficiently.",
      "Return concise findings with file paths and relevant evidence."
    ].join("\n");
  }

  if (type === "plan") {
    return [
      "You are a plan sub-agent.",
      "Stay read-only. Analyze the codebase and return a structured implementation plan.",
      "Include current state, steps, important files, checks, and risks."
    ].join("\n");
  }

  return [
    "You are a general sub-agent.",
    "Stay read-only. Complete the delegated research task and return findings.",
    "Return only the essential result for the parent agent to use."
  ].join("\n");
}

export function filterSubAgentTools(type: SubAgentType, tools: ToolDefinition[]): ToolDefinition[] {
  const withoutRecursiveAgent = tools.filter((tool) => tool.name !== "agent");
  // All sub-agent types are read-only to prevent unintended file modifications.
  // The parent agent should handle all writes itself.
  return withoutRecursiveAgent.filter((tool) => tool.sideEffect === "read" || readOnlyTools.has(tool.name));
}

export function describeSubAgents(): string {
  return [
    "## Sub-Agents",
    "- All sub-agent types are read-only — the parent agent must perform file edits itself.",
    "- explore: read-only code search and evidence gathering.",
    "- plan: read-only architecture analysis and implementation planning.",
    "- general: read-only research and task investigation.",
    "Use the `agent` tool when a delegated task can protect the main context or parallelize research."
  ].join("\n");
}
