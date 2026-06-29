import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type RunLogEvent = {
  event: string;
  timestamp?: string;
  step?: number;
  data?: unknown;
};

export class RunLogger {
  readonly filePath: string;

  constructor(
    private readonly memoryDir: string,
    readonly runId: string
  ) {
    this.filePath = join(memoryDir, "runs", `${runId}.jsonl`);
  }

  async write(event: RunLogEvent): Promise<void> {
    await mkdir(join(this.memoryDir, "runs"), { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      ...event
    };
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}
