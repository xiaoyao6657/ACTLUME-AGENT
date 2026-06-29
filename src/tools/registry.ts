import type { ToolDefinition } from "../types.js";
import { editPlanTool } from "./edit-plan.js";
import { listDirTool, searchTextTool, treeTool } from "./explore.js";
import { applyPatchTool } from "./patch.js";
import { projectScanTool } from "./project-scan.js";
import { appendFileTool, fileExistsTool, readFileTool, writeFileTool } from "./read-write.js";
import { recallTool } from "./recall.js";
import { shellTool } from "./shell.js";
import { taskAddTool, taskListTool, taskUpdateTool } from "./tasks.js";

export const tools: ToolDefinition[] = [
  projectScanTool,
  editPlanTool,
  listDirTool,
  treeTool,
  searchTextTool,
  readFileTool,
  writeFileTool,
  appendFileTool,
  fileExistsTool,
  applyPatchTool,
  shellTool,
  recallTool,
  taskListTool,
  taskAddTool,
  taskUpdateTool
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
