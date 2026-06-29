import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskItem } from "./types.js";

export class TaskTracker {
  private readonly filePath: string;

  constructor(private readonly memoryDir: string) {
    this.filePath = join(memoryDir, "tasks.json");
  }

  async list(): Promise<TaskItem[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as TaskItem[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async add(title: string): Promise<TaskItem> {
    const tasks = await this.list();
    const item: TaskItem = {
      id: crypto.randomUUID(),
      title,
      status: "todo"
    };
    tasks.push(item);
    await this.save(tasks);
    return item;
  }

  async updateStatus(id: string, status: TaskItem["status"]): Promise<TaskItem | undefined> {
    const tasks = await this.list();
    const task = tasks.find((item) => item.id === id);
    if (!task) {
      return undefined;
    }
    task.status = status;
    await this.save(tasks);
    return task;
  }

  private async save(tasks: TaskItem[]): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(tasks, null, 2), "utf8");
  }
}
