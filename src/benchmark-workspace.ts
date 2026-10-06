import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type IsolatedBenchmarkWorkspace = {
  path: string;
  cleanup: () => Promise<void>;
};

export async function createIsolatedBenchmarkWorkspace(): Promise<IsolatedBenchmarkWorkspace> {
  const path = await mkdtemp(join(tmpdir(), "actlume-benchmark-"));
  let cleaned = false;
  return {
    path,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await rm(path, { recursive: true, force: true });
    }
  };
}
