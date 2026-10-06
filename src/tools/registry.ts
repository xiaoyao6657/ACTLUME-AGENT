import type { ToolDefinition } from "../types.js";
import { agentTool } from "./agent.js";
import { readArtifactTool } from "./artifact.js";
import { editPlanTool } from "./edit-plan.js";
import { globTool, listDirTool, searchTextTool, treeTool } from "./explore.js";
import { memoryListTool, memoryRecallTool, memorySaveTool } from "./memory.js";
import { applyPatchTool } from "./patch.js";
import { enterPlanModeTool, exitPlanModeTool, readPlanTool, updatePlanTool, writePlanTool } from "./plan-mode.js";
import { projectScanTool } from "./project-scan.js";
import {
  appendFileTool,
  appendToFileTool,
  fileExistsTool,
  insertTextTool,
  insertAtLineTool,
  readFileTool,
  readTailTool,
  replaceTextTool,
  replaceLinesTool,
  writeFileTool
} from "./read-write.js";
import { recallTool } from "./recall.js";
import { shellTool } from "./shell.js";
import { skillTool } from "./skill.js";
import { taskAddTool, taskListTool, taskUpdateTool } from "./tasks.js";

export const tools: ToolDefinition[] = [
  projectScanTool,
  enterPlanModeTool,
  writePlanTool,
  updatePlanTool,
  readPlanTool,
  exitPlanModeTool,
  editPlanTool,
  globTool,
  listDirTool,
  treeTool,
  searchTextTool,
  readFileTool,
  readTailTool,
  writeFileTool,
  appendFileTool,
  appendToFileTool,
  replaceTextTool,
  insertTextTool,
  replaceLinesTool,
  insertAtLineTool,
  fileExistsTool,
  applyPatchTool,
  shellTool,
  skillTool,
  agentTool,
  memorySaveTool,
  memoryListTool,
  memoryRecallTool,
  recallTool,
  taskListTool,
  taskAddTool,
  taskUpdateTool,
  readArtifactTool
].map((tool) => ({ ...tool, source: "local" }));

export function getToolDescriptions(availableTools: ToolDefinition[] = tools): string {
  return availableTools
    .map((tool) =>
      JSON.stringify(
        {
          name: tool.name,
          description: tool.description,
          sideEffect: tool.sideEffect,
          source: tool.source ?? "local",
          parameters: tool.parameters
        },
        null,
        2
      )
    )
    .join("\n");
}
