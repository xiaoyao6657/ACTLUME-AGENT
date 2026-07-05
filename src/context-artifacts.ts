import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { summarizeText } from "./summary.js";

export type PersistedObservation = {
  observation: string;
  artifactPath?: string;
  originalChars: number;
};

const defaultMaxObservationChars = 30000;
const previewChars = 6000;

export async function persistLargeObservation(params: {
  memoryDir: string;
  runId: string;
  step: number;
  toolName: string;
  observation: string;
  maxChars?: number;
}): Promise<PersistedObservation> {
  const maxChars = params.maxChars ?? defaultMaxObservationChars;
  if (params.observation.length <= maxChars) {
    return { observation: params.observation, originalChars: params.observation.length };
  }

  const dir = join(params.memoryDir, "artifacts", params.runId);
  await mkdir(dir, { recursive: true });
  const filename = `${String(params.step).padStart(3, "0")}-${sanitize(params.toolName)}.txt`;
  const artifactPath = join(dir, filename);
  await writeFile(artifactPath, params.observation, "utf8");
  const pointer = `[artifact:${artifactPath}]`;
  const preview = summarizeText(params.observation, previewChars);
  return {
    observation: [
      `${pointer}`,
      `Observation too large (${params.observation.length} chars). Full content saved to artifact.`,
      "Preview:",
      preview
    ].join("\n"),
    artifactPath,
    originalChars: params.observation.length
  };
}

function sanitize(value: string): string {
  const sanitized = value.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "");
  return sanitized || "tool";
}
