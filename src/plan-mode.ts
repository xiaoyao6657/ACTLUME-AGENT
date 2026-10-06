import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PlanIdentity = { taskId?: string; branchId?: string };

export function getPlanFilePath(memoryDir: string, runId: string, identity: PlanIdentity = {}): string {
  if (identity.taskId && identity.branchId) {
    return join(memoryDir, "plans", "tasks", `${safeId(identity.taskId)}--${safeId(identity.branchId)}.md`);
  }
  return join(memoryDir, "plans", `${safeId(runId)}.md`);
}

export async function writePlanFile(memoryDir: string, runId: string, content: string, identity: PlanIdentity = {}): Promise<string> {
  const path = getPlanFilePath(memoryDir, runId, identity);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

export async function readPlanFile(memoryDir: string, runId: string, identity: PlanIdentity = {}): Promise<{ path: string; content: string }> {
  const path = getPlanFilePath(memoryDir, runId, identity);
  const content = await readFile(path, "utf8");
  return { path, content };
}

function safeId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length <= 120 ? safe : `${safe.slice(0, 80)}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
