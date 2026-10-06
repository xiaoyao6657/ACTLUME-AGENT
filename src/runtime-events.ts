import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRuntimeTraceExporterFromEnv, type TraceExportDiagnostics } from "./otel-exporter.js";

export type RuntimeStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "budget_exhausted"
  | "completed";

export type RuntimeEventKind =
  | "session_started"
  | "run_started"
  | "run_resumed"
  | "run_cancelling"
  | "run_interrupted"
  | "tool_requested"
  | "tool_started"
  | "tool_finished"
  | "approval_requested"
  | "policy_decision"
  | "memory_retrieved"
  | "model_usage"
  | "verification_finished"
  | "verification_invalidated"
  | "task_verdict"
  | "completion_claim"
  | "context_compacted"
  | "context_budget_decision"
  | "agent_started"
  | "agent_finished"
  | "run_finished";

export type RuntimeEvent = {
  schemaVersion: 1;
  eventId: string;
  at: string;
  kind: RuntimeEventKind;
  workspace: string;
  sessionId: string;
  runId?: string;
  taskId?: string;
  branchId?: string;
  agentId?: string;
  parentRunId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  toolName?: string;
  status?: RuntimeStatus;
  outcome?: "allow" | "warn" | "block" | "unknown";
  policyId?: string;
  reasonCode?: string;
  durationMs?: number;
  error?: boolean;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  attributes?: Record<string, string | number | boolean | string[]>;
};

const writeQueues = new Map<string, Promise<void>>();
const eventContexts = new Map<string, { agentId: string; parentRunId?: string }>();
let traceExporter: ReturnType<typeof createRuntimeTraceExporterFromEnv> | undefined;
let traceExporterInitialized = false;

function getTraceExporter(): ReturnType<typeof createRuntimeTraceExporterFromEnv> {
  // Resolve environment-backed settings on first event, after the CLI has had a
  // chance to load .env rather than during ESM module evaluation.
  if (!traceExporterInitialized) {
    traceExporter = createRuntimeTraceExporterFromEnv();
    traceExporterInitialized = true;
  }
  return traceExporter;
}

export function setRuntimeEventContext(memoryDir: string, context: { agentId: string; parentRunId?: string }): void {
  eventContexts.set(resolve(memoryDir), context);
}

export async function flushRuntimeTraceExporter(): Promise<void> {
  await getTraceExporter()?.flush();
}

export function runtimeTraceExportDiagnostics(): TraceExportDiagnostics | undefined {
  return getTraceExporter()?.getDiagnostics();
}

export async function appendRuntimeEvent(memoryDir: string, event: Omit<RuntimeEvent, "schemaVersion" | "eventId" | "at"> & Partial<Pick<RuntimeEvent, "eventId" | "at">>): Promise<RuntimeEvent> {
  const context = eventContexts.get(resolve(memoryDir));
  const record: RuntimeEvent = {
    schemaVersion: 1,
    eventId: event.eventId ?? crypto.randomUUID(),
    at: event.at ?? new Date().toISOString(),
    ...event,
    agentId: event.agentId ?? context?.agentId ?? "main",
    parentRunId: event.parentRunId ?? context?.parentRunId
  };
  const path = runtimeEventPath(memoryDir, record.sessionId);
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const current = previous.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  });
  writeQueues.set(path, current.catch(() => undefined));
  await current;
  const exporter = getTraceExporter();
  if (exporter) void exporter.record(record).catch(() => undefined);
  return record;
}

export async function readRuntimeEvents(memoryDir: string, sessionId: string): Promise<RuntimeEvent[]> {
  try {
    const raw = await readFile(runtimeEventPath(memoryDir, sessionId), "utf8");
    return raw.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Invalid runtime event JSON at ${runtimeEventPath(memoryDir, sessionId)}:${index + 1}.`);
      }
      if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.eventId !== "string"
        || typeof value.kind !== "string" || typeof value.sessionId !== "string") {
        throw new Error(`Unsupported or malformed runtime event at ${runtimeEventPath(memoryDir, sessionId)}:${index + 1}; expected schemaVersion 1.`);
      }
      return [value as unknown as RuntimeEvent];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function findLatestRuntimeSession(memoryDir: string, workspace?: string): Promise<string | undefined> {
  let files: string[];
  try {
    files = (await readdir(join(memoryDir, "events"))).filter((file) => file.endsWith(".jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const candidates = await Promise.all(files.map(async (file) => {
    const sessionId = file.slice(0, -".jsonl".length);
    const [fileStat, events] = await Promise.all([
      stat(join(memoryDir, "events", file)),
      readRuntimeEvents(memoryDir, sessionId)
    ]);
    const started = events.find((event) => event.kind === "session_started"
      && Boolean(event.attributes?.sessionFile)
      && (!workspace || event.workspace === workspace));
    return started ? { sessionId, mtimeMs: fileStat.mtimeMs } : undefined;
  }));
  return candidates
    .filter((item): item is { sessionId: string; mtimeMs: number } => Boolean(item))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.sessionId;
}

export function runtimeEventPath(memoryDir: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(memoryDir, "events", `${safeSessionId}.jsonl`);
}
