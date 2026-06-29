import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type MultilineState = {
  lines: string[];
};

export const emptyMultilineState = (): MultilineState => ({ lines: [] });

export type MultilineResult =
  | { ready: false; prompt: string }
  | { ready: true; text: string; prompt: string };

export function consumeMultilineInput(state: MultilineState, rawLine: string): MultilineResult {
  const continuation = rawLine.endsWith("\\");
  const line = continuation ? rawLine.slice(0, -1) : rawLine;

  if (continuation) {
    state.lines.push(line);
    return { ready: false, prompt: "... " };
  }

  if (state.lines.length === 0) {
    return { ready: true, text: rawLine, prompt: "\nactlume> " };
  }

  state.lines.push(line);
  const text = state.lines.join("\n");
  state.lines = [];
  return { ready: true, text, prompt: "\nactlume> " };
}

export function historyFilePath(): string {
  return resolve(process.env.ACTLUME_HOME ?? homedir(), ".actlume", "history");
}

export async function loadHistory(limit = 200): Promise<string[]> {
  try {
    const raw = await readFile(historyFilePath(), "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit)
      .reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function appendHistory(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return;
  }
  const path = historyFilePath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${trimmed.replace(/\r?\n/g, "\\n")}\n`, "utf8");
}

export function color(text: string, code: number): string {
  if (!colorsEnabled()) {
    return text;
  }
  return `\x1b[${code}m${text}\x1b[0m`;
}

export function colorsEnabled(): boolean {
  return process.env.NO_COLOR !== "1" && process.stdout.isTTY === true;
}

export function label(name: string): string {
  return color(name, 36);
}

export function success(text: string): string {
  return color(text, 32);
}

export function warning(text: string): string {
  return color(text, 33);
}

export function errorText(text: string): string {
  return color(text, 31);
}

export function renderMarkdown(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (/^#{1,6}\s+/.test(line)) {
        return color(line, 36);
      }
      if (/^\s*[-*]\s+/.test(line)) {
        return line.replace(/^(\s*[-*])/, color("$1", 36));
      }
      if (/^```/.test(line)) {
        return color(line, 90);
      }
      return line;
    })
    .join("\n");
}

export function highlightDiff(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
        return color(line, 36);
      }
      if (line.startsWith("+")) {
        return success(line);
      }
      if (line.startsWith("-")) {
        return errorText(line);
      }
      return line;
    })
    .join("\n");
}
