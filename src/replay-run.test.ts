import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const replayScript = fileURLToPath(new URL("../scripts/replay-run.ts", import.meta.url));

test("replay keeps a missing tool result unknown and does not infer a successful edit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "actlume-replay-unknown-"));
  try {
    const logPath = join(workspace, ".agent-memory", "runs", "run.jsonl");
    await mkdir(dirname(logPath), { recursive: true });
    const events = [
      { event: "turn_start", step: 1, data: { prompt: "User task:\nImplement the missing parser case.\n\nModel context:\n" } },
      { event: "llm_response", step: 1, data: { raw: JSON.stringify({ type: "action", thought: "Plan the fix", tool: "editPlan", input: { summary: "Fix parser", expectedFiles: ["src/parser.ts"], steps: ["Add the missing case"] } }) } },
      { event: "llm_response", step: 2, data: { raw: JSON.stringify({ type: "action", thought: "Add a case", tool: "writeFile", input: { path: "src/parser.ts", content: "export const fixed = true;" } }) } },
      { event: "llm_response", step: 3, data: { raw: JSON.stringify({ type: "final", answer: "Done." }) } },
      { event: "run_end", data: { status: "completed" } }
    ];
    await writeFile(logPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const result = await execFileAsync(process.execPath, ["--import", "tsx", replayScript, logPath], { cwd: process.cwd() });
    assert.match(result.stdout, /editPlan unknown REPLAY_RESULT_UNKNOWN/);
    assert.match(result.stdout, /writeFile blocked STAGE_INTENT_BLOCKED/);
    assert.match(result.stdout, /finalAssessment: failed/);
    assert.doesNotMatch(result.stdout, /Replay assumed success/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
