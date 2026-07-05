import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EditWorkflowState } from "./edit-workflow.js";
import type { AgentHistoryItem, Session } from "./types.js";

export type SessionSnapshot = {
  metadata: Session;
  history: AgentHistoryItem[];
  answer?: string;
  workflowState?: EditWorkflowState;
  updatedAt: string;
};

export type SessionListItem = {
  id: string;
  startedAt: string;
  endedAt?: string;
  userTask: string;
  status: Session["status"];
  resumedFrom?: string;
  historyLength: number;
  updatedAt: string;
};

export async function startSession(memoryDir: string, userTask: string, resumedFrom?: string): Promise<Session> {
  const session: Session = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    userTask,
    status: "running",
    resumedFrom
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

export async function saveSessionSnapshot(
  memoryDir: string,
  session: Session,
  history: AgentHistoryItem[],
  answer?: string,
  workflowState?: EditWorkflowState
): Promise<SessionSnapshot> {
  const snapshot: SessionSnapshot = {
    metadata: session,
    history,
    answer,
    workflowState,
    updatedAt: new Date().toISOString()
  };
  const dir = sessionSnapshotDir(memoryDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${session.id}.json`), JSON.stringify(snapshot, null, 2), "utf8");
  return snapshot;
}

export async function loadSessionSnapshot(memoryDir: string, id: string): Promise<SessionSnapshot | undefined> {
  try {
    const raw = await readFile(join(sessionSnapshotDir(memoryDir), `${id}.json`), "utf8");
    return JSON.parse(raw) as SessionSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function listSessionSnapshots(memoryDir: string): Promise<SessionListItem[]> {
  let files: string[];
  try {
    files = await readdir(sessionSnapshotDir(memoryDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const snapshots = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        try {
          const raw = await readFile(join(sessionSnapshotDir(memoryDir), file), "utf8");
          return JSON.parse(raw) as SessionSnapshot;
        } catch {
          return undefined;
        }
      })
  );

  return snapshots
    .filter((snapshot): snapshot is SessionSnapshot => Boolean(snapshot))
    .map((snapshot) => ({
      id: snapshot.metadata.id,
      startedAt: snapshot.metadata.startedAt,
      endedAt: snapshot.metadata.endedAt,
      userTask: snapshot.metadata.userTask,
      status: snapshot.metadata.status,
      resumedFrom: snapshot.metadata.resumedFrom,
      historyLength: snapshot.history.length,
      updatedAt: snapshot.updatedAt
    }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function getLatestSessionSnapshot(memoryDir: string): Promise<SessionSnapshot | undefined> {
  const sessions = await listSessionSnapshots(memoryDir);
  const latest = sessions[0];
  return latest ? loadSessionSnapshot(memoryDir, latest.id) : undefined;
}

function sessionSnapshotDir(memoryDir: string): string {
  return join(memoryDir, "sessions");
}
