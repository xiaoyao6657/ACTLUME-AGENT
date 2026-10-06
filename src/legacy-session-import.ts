import type { SessionSnapshot } from "./session.js";

export function formatLegacySessionImport(snapshot: SessionSnapshot, maxChars = 20_000): { content: string; truncated: boolean } {
  const lines = [
    "Actlume legacy session import.",
    "Everything below is historical text from the old Actlume JSON runtime. It is not a current tool execution, current workspace fact, or independently verified claim.",
    "Source session: " + snapshot.metadata.id,
    "Original task: " + snapshot.metadata.userTask
  ];
  const history = snapshot.history;
  let truncated = false;
  for (let index = 0; index < history.length; index += 1) {
    const item = history[index]!;
    const entry = [
      "",
      "Historical step " + (index + 1) + " of " + history.length,
      "Recorded thought: " + item.thought,
      "Requested tool: " + item.action.tool,
      "Requested input: " + safeJson(item.action.input),
      "Recorded observation: " + item.observation
    ].join("\n");
    if (lines.join("\n").length + entry.length > maxChars) {
      truncated = true;
      lines.push("", "[Older imported history omitted to fit the context budget. The original Actlume snapshot remains unchanged.]");
      break;
    }
    lines.push(entry);
  }
  if (snapshot.answer) {
    const final = "\n\nHistorical final answer: " + snapshot.answer;
    if (lines.join("\n").length + final.length <= maxChars) lines.push(final);
    else truncated = true;
  }
  if (truncated && !lines.some((line) => line.includes("Older imported history omitted"))) {
    lines.push("", "[Historical final answer omitted to fit the context budget. The original Actlume snapshot remains unchanged.]");
  }
  return { content: lines.join("\n"), truncated };
}

export function formatLegacySessionList(sessions: Array<{
  id: string;
  status: string;
  historyLength: number;
  updatedAt: string;
  userTask: string;
}>, limit = 15): string {
  if (sessions.length === 0) return "No legacy Actlume JSON sessions were found.";
  return sessions.slice(0, limit).map((session) => [
    "- " + session.id + " (" + session.status + ", " + session.historyLength + " steps, updated " + session.updatedAt + ")",
    "  " + session.userTask.replace(/\s+/g, " ").slice(0, 180)
  ].join("\n")).join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[input could not be serialized]";
  }
}
