import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function getPlanFilePath(memoryDir: string, runId: string): string {
  return join(memoryDir, "plans", `${runId}.md`);
}

export async function writePlanFile(memoryDir: string, runId: string, content: string): Promise<string> {
  const path = getPlanFilePath(memoryDir, runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

export async function readPlanFile(memoryDir: string, runId: string): Promise<{ path: string; content: string }> {
  const path = getPlanFilePath(memoryDir, runId);
  const content = await readFile(path, "utf8");
  return { path, content };
}
