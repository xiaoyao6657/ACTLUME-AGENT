import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "./types.js";

export async function startSession(memoryDir: string, userTask: string): Promise<Session> {
  const session: Session = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    userTask,
    status: "running"
  };
  await saveSession(memoryDir, session);
  return session;
}

export async function finishSession(
  memoryDir: string,
  session: Session,
  status: "completed" | "failed"
): Promise<Session> {
  const finished: Session = {
    ...session,
    endedAt: new Date().toISOString(),
    status
  };
  await saveSession(memoryDir, finished);
  return finished;
}

async function saveSession(memoryDir: string, session: Session): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  await appendFile(join(memoryDir, "sessions.jsonl"), `${JSON.stringify(session)}\n`, "utf8");
}
