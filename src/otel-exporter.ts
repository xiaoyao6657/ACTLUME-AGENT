import { createHash } from "node:crypto";
import type { RuntimeEvent } from "./runtime-events.js";

type OpenSpan = { event: RuntimeEvent; name: string; key: string };
type AttributeValue = string | number | boolean | string[];
type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status: { code: number; message?: string };
};

export type TraceExportDiagnostics = {
  queueLimit: number;
  queued: number;
  exported: number;
  dropped: number;
  httpErrors: number;
  timeouts: number;
  networkErrors: number;
  lastHttpStatus?: number;
  lastError?: string;
};

type QueuedExport = { payload: unknown; settle: () => void };

/** Sends compact OTLP/HTTP JSON spans. Export errors are contained so telemetry never blocks a run. */
export class OtlpRuntimeExporter {
  private readonly openSpans = new Map<string, OpenSpan>();
  private readonly queue: QueuedExport[] = [];
  private drainPromise: Promise<void> | undefined;
  private readonly timeoutMs: number;
  private readonly queueLimit: number;
  private readonly diagnostics: TraceExportDiagnostics;

  constructor(
    private readonly endpoint: string,
    private readonly headers: Record<string, string> = {},
    options: { timeoutMs?: number; maxQueueSize?: number } = {}
  ) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 2_000);
    this.queueLimit = Math.max(1, Math.trunc(options.maxQueueSize ?? 128));
    this.diagnostics = { queueLimit: this.queueLimit, queued: 0, exported: 0, dropped: 0, httpErrors: 0, timeouts: 0, networkErrors: 0 };
  }

  getDiagnostics(): TraceExportDiagnostics {
    return { ...this.diagnostics, queued: this.queue.length + (this.drainPromise ? 1 : 0) };
  }

  async record(event: RuntimeEvent): Promise<void> {
    const pair = pairIdentity(event);
    if (pair?.phase === "start") {
      this.openSpans.set(pair.key, { event, name: pair.name, key: pair.key });
      return;
    }
    const spans: OtlpSpan[] = [];
    if (pair?.phase === "finish") {
      const start = this.openSpans.get(pair.key);
      if (start) {
        this.openSpans.delete(pair.key);
        spans.push(buildSpan(start.event, event, start.name));
      } else {
        spans.push(buildSpan(event, event, pair.name));
      }
    } else if (event.kind !== "session_started" && event.kind !== "run_started" && event.kind !== "tool_started" && event.kind !== "agent_started") {
      spans.push(buildSpan(event, event, spanName(event)));
    }
    if (spans.length === 0) return;
    if (this.queue.length >= this.queueLimit) {
      this.diagnostics.dropped += 1;
      this.diagnostics.lastError = "bounded exporter queue is full";
      return;
    }
    await new Promise<void>((settle) => {
      this.queue.push({ payload: toOtlpPayload(spans), settle });
      void this.startDrain();
    });
  }

  async flush(): Promise<void> {
    while (this.drainPromise || this.queue.length > 0) {
      if (this.drainPromise) await this.drainPromise;
      else await this.startDrain();
    }
  }

  private startDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainQueue().finally(() => {
      this.drainPromise = undefined;
      if (this.queue.length > 0) void this.startDrain();
    });
    return this.drainPromise;
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers },
          body: JSON.stringify(item.payload),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!response.ok) {
          this.diagnostics.httpErrors += 1;
          this.diagnostics.dropped += 1;
          this.diagnostics.lastHttpStatus = response.status;
          this.diagnostics.lastError = `collector returned HTTP ${response.status}`;
        } else {
          this.diagnostics.exported += 1;
          this.diagnostics.lastError = undefined;
          this.diagnostics.lastHttpStatus = undefined;
        }
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        this.diagnostics.dropped += 1;
        const name = error instanceof Error ? error.name : "unknown";
        if (name === "TimeoutError" || name === "AbortError") {
          this.diagnostics.timeouts += 1;
          this.diagnostics.lastError = `collector request timed out after ${this.timeoutMs}ms`;
        } else {
          this.diagnostics.networkErrors += 1;
          this.diagnostics.lastError = "collector request failed";
        }
      } finally {
        item.settle();
      }
    }
  }
}

export function createRuntimeTraceExporterFromEnv(env: NodeJS.ProcessEnv = process.env): OtlpRuntimeExporter | undefined {
  const endpoint = getRuntimeTraceEndpoint(env);
  if (!endpoint) return undefined;
  const normalizedEndpoint = /\/v1\/traces\/?$/.test(endpoint) || /\/otel\/v1\/traces\/?$/.test(endpoint)
    ? endpoint
    : endpoint.replace(/\/+$/, "") + "/v1/traces";
  const rawHeaders = env.ACTLUME_OTEL_EXPORTER_OTLP_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS ?? "";
  const headers: Record<string, string> = {};
  for (const entry of rawHeaders.split(",")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!key) continue;
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return new OtlpRuntimeExporter(normalizedEndpoint, headers);
}

export function isRuntimeTraceExportConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getRuntimeTraceEndpoint(env) !== undefined;
}

function getRuntimeTraceEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  return [
    env.ACTLUME_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    env.ACTLUME_OTEL_EXPORTER_OTLP_ENDPOINT,
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    env.OTEL_EXPORTER_OTLP_ENDPOINT
  ].find((value) => value?.trim().length) ?? undefined;
}

export function toOtlpPayload(spans: OtlpSpan[]): unknown {
  return {
    resourceSpans: [{
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "actlume-agent" } }]
      },
      scopeSpans: [{
        scope: { name: "actlume-agent", version: "0.1.0" },
        spans
      }]
    }]
  };
}

function pairIdentity(event: RuntimeEvent): { key: string; phase: "start" | "finish"; name: string } | undefined {
  if (event.kind === "run_started" && event.runId) return { key: "run:" + event.runId, phase: "start", name: "actlume.run" };
  if (event.kind === "run_finished" && event.runId) return { key: "run:" + event.runId, phase: "finish", name: "actlume.run" };
  if (event.kind === "tool_started" && event.toolCallId) return { key: "tool:" + event.toolCallId, phase: "start", name: "actlume.tool" };
  if (event.kind === "tool_finished" && event.toolCallId) return { key: "tool:" + event.toolCallId, phase: "finish", name: "actlume.tool" };
  if (event.kind === "agent_started" && event.agentId) return { key: "agent:" + event.agentId, phase: "start", name: "actlume.subagent" };
  if (event.kind === "agent_finished" && event.agentId) return { key: "agent:" + event.agentId, phase: "finish", name: "actlume.subagent" };
  return undefined;
}

function spanName(event: RuntimeEvent): string {
  if (event.kind === "model_usage") return "gen_ai.chat";
  return "actlume." + event.kind;
}

function buildSpan(start: RuntimeEvent, finish: RuntimeEvent, name: string): OtlpSpan {
  const rootRunId = finish.parentRunId ?? start.parentRunId ?? start.runId ?? finish.runId ?? finish.sessionId;
  const agentId = finish.agentId ?? start.agentId ?? "main";
  const spanIdentity = name === "actlume.run"
    ? "run:" + (finish.runId ?? start.runId ?? finish.eventId)
    : name === "actlume.subagent"
      ? "agent:" + agentId
      : name === "actlume.tool"
        ? "tool:" + (finish.toolCallId ?? start.toolCallId ?? finish.eventId)
        : "event:" + finish.eventId;
  const parentSpanId = name === "actlume.run"
    ? (agentId !== "main" && finish.parentRunId ? stableId("agent:" + agentId, 8) : finish.parentRunId ? stableId("run:" + finish.parentRunId, 8) : undefined)
    : name === "actlume.subagent"
      ? (finish.parentRunId ? stableId("run:" + finish.parentRunId, 8) : undefined)
      : name === "actlume.tool"
        ? finish.parentToolCallId
          ? stableId("tool:" + finish.parentToolCallId, 8)
          : (agentId !== "main" && finish.runId ? stableId("run:" + finish.runId, 8) : finish.runId ? stableId("run:" + finish.runId, 8) : undefined)
        : finish.runId
          ? stableId("run:" + finish.runId, 8)
          : undefined;
  const error = finish.error === true || ["failed", "cancelled", "interrupted", "budget_exhausted"].includes(finish.status ?? "");
  const attrs: Record<string, AttributeValue> = {
    "actlume.event.kind": finish.kind,
    "actlume.status": finish.status ?? "unknown",
    "actlume.agent.id": agentId
  };
  if (finish.toolName) attrs["tool.name"] = finish.toolName;
  if (finish.taskId) attrs["actlume.task.id"] = finish.taskId;
  if (finish.branchId) attrs["actlume.branch.id"] = finish.branchId;
  if (finish.outcome) attrs["actlume.policy.outcome"] = finish.outcome;
  if (finish.policyId) attrs["actlume.policy.id"] = finish.policyId;
  if (finish.reasonCode) attrs["actlume.policy.reason_code"] = finish.reasonCode;
  if (finish.error !== undefined) attrs["error"] = finish.error;
  if (finish.durationMs !== undefined) attrs["actlume.duration_ms"] = finish.durationMs;
  if (finish.usage?.input !== undefined) attrs["gen_ai.usage.input_tokens"] = finish.usage.input;
  if (finish.usage?.output !== undefined) attrs["gen_ai.usage.output_tokens"] = finish.usage.output;
  if (finish.usage?.cacheRead !== undefined) attrs["gen_ai.usage.cache_read.input_tokens"] = finish.usage.cacheRead;
  if (finish.usage?.cacheWrite !== undefined) attrs["gen_ai.usage.cache_write.input_tokens"] = finish.usage.cacheWrite;
  addSafeAttributes(attrs, finish.attributes);
  const at = Date.parse(finish.at);
  const end = Number.isFinite(at) ? at : Date.now();
  const duration = name === "gen_ai.chat" && finish.durationMs !== undefined ? Math.max(0, finish.durationMs) : 0;
  const startAt = start === finish ? end - duration : Date.parse(start.at);
  return {
    traceId: stableId("trace:" + rootRunId, 16),
    spanId: stableId(spanIdentity, 8),
    parentSpanId,
    name,
    kind: name === "actlume.tool" || name === "gen_ai.chat" ? 3 : 1,
    startTimeUnixNano: toUnixNanos(Number.isFinite(startAt) ? startAt : end),
    endTimeUnixNano: toUnixNanos(end),
    attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: toAnyValue(value) })),
    status: error ? { code: 2, message: finish.reasonCode ?? "runtime operation failed" } : { code: 1 }
  };
}

function addSafeAttributes(target: Record<string, AttributeValue>, source: RuntimeEvent["attributes"]): void {
  if (!source) return;
  const allowed = new Set([
    "taskOutcome", "selectedMemoryCount", "turns", "toolCalls", "modelRequests",
    "maxSteps", "maxToolCalls", "mode", "checkKind", "unresolvedCount"
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      target["actlume." + key] = value;
    }
  }
}

function toAnyValue(value: AttributeValue): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { intValue: String(value) };
  return { arrayValue: { values: value.map((item) => ({ stringValue: item })) } };
}

function stableId(value: string, bytes: 8 | 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, bytes * 2);
}

function toUnixNanos(milliseconds: number): string {
  return (BigInt(Math.trunc(milliseconds)) * 1_000_000n).toString();
}
