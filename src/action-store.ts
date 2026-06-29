import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionRecord } from "./types.js";

export class ActionStore {
  readonly filePath: string;

  constructor(private readonly memoryDir: string) {
    this.filePath = join(memoryDir, "actions.jsonl");
  }

  async save(record: Omit<ActionRecord, "id" | "timestamp">): Promise<ActionRecord> {
    await mkdir(this.memoryDir, { recursive: true });
    const fullRecord: ActionRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...record
    };
    await appendFile(this.filePath, `${JSON.stringify(fullRecord)}\n`, "utf8");
    return fullRecord;
  }

  async list(): Promise<ActionRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ActionRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async search(keyword: string, limit = 10): Promise<ActionRecord[]> {
    const lower = keyword.toLowerCase();
    const records = await this.list();
    return records
      .filter((record) => JSON.stringify(record).toLowerCase().includes(lower))
      .slice(-limit)
      .reverse();
  }
}
