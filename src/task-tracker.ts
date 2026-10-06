import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TaskItem } from "./types.js";

const mutationQueues = new Map<string, Promise<void>>();

export class TaskTracker {
  private readonly filePath: string;

  constructor(private readonly memoryDir: string, workspace = dirname(resolve(memoryDir))) {
    const root = resolve(workspace);
    const storage = resolve(memoryDir);
    const relativeStorage = relative(root, storage);
    const storageIsWorkspaceScoped = relativeStorage !== ".."
      && !relativeStorage.startsWith(`..${sep}`)
      && !isAbsolute(relativeStorage);
    this.filePath = storageIsWorkspaceScoped
      ? join(storage, "tasks.json")
      : join(storage, "tasks", `${createHash("sha256").update(root).digest("hex").slice(0, 24)}.json`);
  }

  async list(): Promise<TaskItem[]> {
    return this.read();
  }

  async add(title: string): Promise<TaskItem> {
    return await this.mutate(async (tasks) => {
      const item: TaskItem = { id: randomUUID(), title, status: "todo" };
      tasks.push(item);
      await this.write(tasks);
      return item;
    });
  }

  async updateStatus(id: string, status: TaskItem["status"]): Promise<TaskItem | undefined> {
    return await this.mutate(async (tasks) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;
      task.status = status;
      await this.write(tasks);
      return task;
    });
  }

  private async mutate<T>(operation: (tasks: TaskItem[]) => Promise<T>): Promise<T> {
    return await withPathQueue(this.filePath, async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const release = await acquireFileLock(`${this.filePath}.lock`);
      try {
        return await operation(await this.read());
      } finally {
        await release();
      }
    });
  }

  private async read(): Promise<TaskItem[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error(`Task tracker at ${this.filePath} must contain a JSON array.`);
      return parsed.filter(isTaskItem);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async write(tasks: TaskItem[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(tasks, null, 2), "utf8");
    await rename(temporary, this.filePath);
  }
}

async function withPathQueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const queued = previous.then(() => gate);
  mutationQueues.set(path, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(path) === queued) mutationQueues.delete(path);
  }
}

async function acquireFileLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > 30_000) {
          await rm(path, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for task tracker lock: ${path}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
}

function isTaskItem(value: unknown): value is TaskItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TaskItem>;
  return typeof item.id === "string" && typeof item.title === "string"
    && ["todo", "doing", "done", "blocked"].includes(item.status ?? "");
}
