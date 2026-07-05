// LLM output JSON parsing and repair — extracted from agent.ts
import { z } from "zod";
import type { AgentActionOutput, AgentFinalOutput, AgentOutput } from "./types.js";
import { summarizeText } from "./summary.js";

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

export function parseAgentOutput(raw: string): { ok: true; value: AgentOutput } | { ok: false; error: string } {
  const candidates = [stripJsonFence(raw.trim()), extractFirstJsonObject(raw)].filter((item): item is string => Boolean(item));
  let firstError: unknown;

  for (const candidate of candidates) {
    const parsed = parseJsonWithRepair(candidate);
    if (!parsed.ok) {
      firstError ??= parsed.error;
      continue;
    }

    try {
      return { ok: true, value: agentOutputSchema.parse(normalizeAgentOutput(parsed.value)) as AgentActionOutput | AgentFinalOutput };
    } catch (error) {
      firstError ??= error;
    }
  }

  return { ok: false, error: firstError instanceof Error ? firstError.message : String(firstError ?? "Unable to parse agent output") };
}

export function formatActionInputForPrompt(action: AgentActionOutput, maxChars = 700): string {
  const input = normalizeActionInputForPrompt(action);
  return summarizeText(JSON.stringify(input), maxChars);
}

// ── internals ────────────────────────────────────────────────────────

function normalizeAgentOutput(parsed: unknown): unknown {
  if (!isRecord(parsed) || parsed.type !== "action") {
    return parsed;
  }

  const tool = typeof parsed.tool === "string" ? parsed.tool : typeof parsed.action === "string" ? parsed.action : parsed.tool;
  let input = parsed.input;
  if (!("input" in parsed)) {
    const topLevelInput: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!["type", "thought", "tool", "action"].includes(key)) {
        topLevelInput[key] = value;
      }
    }
    input = topLevelInput;
  }

  return { type: parsed.type, thought: normalizeActionThought(parsed.thought, String(tool)), tool, input };
}

function normalizeActionThought(thought: unknown, toolName: string): string {
  if (typeof thought !== "string" || !thought.trim() || /[㐀-鿿]/.test(thought)) {
    return `Call ${toolName} for the next workflow step.`;
  }
  return thought;
}

function normalizeActionInputForPrompt(action: AgentActionOutput): unknown {
  if (action.tool !== "shell" || !action.input || typeof action.input !== "object" || !("command" in action.input)) {
    return action.input;
  }
  const input = action.input as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : "";
  return {
    ...input,
    command: command.length > 500
      ? `${command.slice(0, 320)}\n...\n[command compressed: ${command.length} chars]\n...\n${command.slice(-120)}`
      : command
  };
}

function parseJsonWithRepair(text: string): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    const repairs = [escapeControlCharactersInsideStrings(text)];
    repairs.push(repairJsonScalarTrailingQuotes(repairs[0]));
    const repairedFinal = repairUnterminatedFinalAnswer(repairs[0]);
    if (repairedFinal) repairs.push(repairedFinal);
    for (const repaired of repairs) {
      try {
        return { ok: true, value: JSON.parse(repaired) as unknown };
      } catch { /* try next */ }
    }
    return { ok: false, error: error as Error };
  }
}

function repairUnterminatedFinalAnswer(text: string): string | undefined {
  const marker = '"answer":"';
  const start = text.indexOf('{"type":"final"');
  const answerStart = text.indexOf(marker);
  if (start !== 0 || answerStart === -1) return undefined;
  const answer = text.slice(answerStart + marker.length);
  if (answer.endsWith('"}') || answer.endsWith('"}\n')) return undefined;
  const trimmed = answer.replace(/\s*$/, "");
  const safeAnswer = trimmed.replace(/(?<!\\)"/g, '\\"');
  return `${text.slice(0, answerStart + marker.length)}${safeAnswer}"}`;
}

function repairJsonScalarTrailingQuotes(text: string): string {
  return text
    .replace(/:\s*(-?\d+(?:\.\d+)?)"(\s*[,}])/g, ":$1$2")
    .replace(/:\s*(true|false|null)"(\s*[,}])/gi, ":$1$2");
}

function escapeControlCharactersInsideStrings(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) { output += char; escaped = false; continue; }
    if (char === "\\") { output += char; escaped = true; continue; }
    if (char === '"') { output += char; inString = !inString; continue; }
    if (inString && char === "\n") { output += "\\n"; continue; }
    if (inString && char === "\r") { output += "\\r"; continue; }
    if (inString && char === "\t") { output += "\\t"; continue; }
    output += char;
  }
  return output;
}

function stripJsonFence(text: string): string {
  if (!text.startsWith("```")) return text;
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") { depth -= 1; if (depth === 0) return text.slice(start, i + 1); }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
