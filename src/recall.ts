import type { ActionRecord } from "./types.js";
import { ActionStore } from "./action-store.js";

export async function recallActions(memoryDir: string, keyword: string, limit = 10): Promise<ActionRecord[]> {
  const store = new ActionStore(memoryDir);
  return store.search(keyword, limit);
}

export function formatRecallResults(records: ActionRecord[]): string {
  if (records.length === 0) {
    return "No matching action records found.";
  }

  return records
    .map((record, index) => {
      const input = record.toolInput === undefined ? "" : `\ninput: ${JSON.stringify(record.toolInput)}`;
      const observation = record.summary ?? record.observation ?? "";
      return [
        `#${index + 1} ${record.timestamp}`,
        `tool: ${record.toolName ?? "unknown"}`,
        `thought: ${record.thought ?? ""}`,
        input,
        `observation: ${observation.slice(0, 800)}`
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
