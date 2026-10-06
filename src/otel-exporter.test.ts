import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { OtlpRuntimeExporter, createRuntimeTraceExporterFromEnv, isRuntimeTraceExportConfigured } from "./otel-exporter.js";
import type { RuntimeEvent } from "./runtime-events.js";

test("OTLP exporter emits correlated run, tool, and child spans without raw task attributes", async () => {
  const payloads: Array<Record<string, any>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const exporter = new OtlpRuntimeExporter("http://127.0.0.1:" + address.port + "/v1/traces", { authorization: "Bearer test" });
  const base = { schemaVersion: 1 as const, eventId: "event", at: "2026-10-05T00:00:00.000Z", workspace: "/private/project", sessionId: "session-1" };
  const events: RuntimeEvent[] = [
    { ...base, eventId: "run-start", kind: "run_started", runId: "run-root", agentId: "main", status: "running" },
    { ...base, eventId: "tool-start", kind: "tool_started", runId: "run-root", agentId: "main", toolCallId: "call-1", toolName: "readFile" },
    { ...base, eventId: "tool-end", kind: "tool_finished", runId: "run-root", agentId: "main", toolCallId: "call-1", toolName: "readFile", durationMs: 21, error: false },
    { ...base, eventId: "agent-start", kind: "agent_started", runId: "run-root", parentRunId: "run-root", agentId: "agent-child", status: "running" },
    { ...base, eventId: "agent-end", kind: "agent_finished", runId: "run-child", parentRunId: "run-root", agentId: "agent-child", status: "completed" },
    { ...base, eventId: "child-start", kind: "run_started", runId: "run-child", parentRunId: "run-root", agentId: "agent-child", status: "running" },
    { ...base, eventId: "child-end", kind: "run_finished", runId: "run-child", parentRunId: "run-root", agentId: "agent-child", status: "completed", attributes: { taskOutcome: "no_change", reason: "private task prompt" } },
    { ...base, eventId: "run-end", kind: "run_finished", runId: "run-root", agentId: "main", status: "completed" }
  ];
  try {
    for (const event of events) await exporter.record(event);
    const spans = payloads.flatMap((payload) => payload.resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)));
    const byName = new Map(spans.map((span) => [span.name + ":" + (span.parentSpanId ?? ""), span]));
    const root = spans.find((span) => span.name === "actlume.run" && !span.parentSpanId);
    const agent = spans.find((span) => span.name === "actlume.subagent");
    const childRun = spans.find((span) => span.name === "actlume.run" && span.parentSpanId === agent?.spanId);
    const tool = spans.find((span) => span.name === "actlume.tool");
    assert.ok(root);
    assert.ok(agent);
    assert.ok(childRun);
    assert.ok(tool);
    assert.equal(new Set(spans.map((span) => span.traceId)).size, 1);
    assert.equal(agent?.parentSpanId, root?.spanId);
    assert.equal(tool?.parentSpanId, root?.spanId);
    assert.equal(childRun?.parentSpanId, agent?.spanId);
    assert.equal(JSON.stringify(payloads).includes("private task prompt"), false);
    assert.equal(byName.size > 0, true);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test("OTLP exporter failure is contained and environment endpoint/header parsing supports Langfuse", async () => {
  const exporter = new OtlpRuntimeExporter("http://127.0.0.1:1/v1/traces");
  await assert.doesNotReject(exporter.record({
    schemaVersion: 1,
    eventId: "policy-event",
    at: new Date().toISOString(),
    kind: "policy_decision",
    workspace: "/private",
    sessionId: "session",
    runId: "run",
    status: "completed",
    policyId: "workflow-v1",
    reasonCode: "WORKFLOW_ALLOWED",
    attributes: { reason: "must not be exported" }
  }));
  const fromEnv = createRuntimeTraceExporterFromEnv({
    ACTLUME_OTEL_EXPORTER_OTLP_ENDPOINT: "https://cloud.langfuse.com/api/public/otel",
    ACTLUME_OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20dGVzdA%3D%3D"
  });
  assert.ok(fromEnv);
  assert.equal(isRuntimeTraceExportConfigured({ ACTLUME_OTEL_EXPORTER_OTLP_ENDPOINT: " " }), false);
  assert.equal(isRuntimeTraceExportConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example" }), true);
});

test("OTLP exporter records HTTP 401/500 drops in bounded diagnostics", async () => {
  let status = 401;
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" }).end("{\"error\":true}");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const exporter = new OtlpRuntimeExporter(`http://127.0.0.1:${address.port}/v1/traces`);
  const event = (eventId: string): RuntimeEvent => ({
    schemaVersion: 1, eventId, at: new Date().toISOString(), kind: "policy_decision", workspace: "/private", sessionId: "s",
    runId: "r", status: "completed", policyId: "policy", reasonCode: "decision"
  });
  try {
    await exporter.record(event("401"));
    status = 500;
    await exporter.record(event("500"));
    await exporter.flush();
    assert.deepEqual(exporter.getDiagnostics(), {
      queueLimit: 128, queued: 0, exported: 0, dropped: 2, httpErrors: 2, timeouts: 0,
      networkErrors: 0, lastHttpStatus: 500, lastError: "collector returned HTTP 500"
    });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test("OTLP exporter bounds queued batches and drains pending spans", async () => {
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolveStarted) => { markFirstStarted = resolveStarted; });
  const firstGate = new Promise<void>((resolveRelease) => { releaseFirst = resolveRelease; });
  let requestCount = 0;
  const server = createServer(async (_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      markFirstStarted();
      await firstGate;
    }
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const exporter = new OtlpRuntimeExporter(`http://127.0.0.1:${address.port}/v1/traces`, {}, { maxQueueSize: 1 });
  const event = (eventId: string): RuntimeEvent => ({
    schemaVersion: 1, eventId, at: new Date().toISOString(), kind: "policy_decision", workspace: "/private", sessionId: "s",
    runId: "r", status: "completed", policyId: "policy", reasonCode: "decision"
  });
  try {
    const first = exporter.record(event("first"));
    await firstStarted;
    const second = exporter.record(event("second"));
    const overflow = exporter.record(event("overflow"));
    assert.equal(exporter.getDiagnostics().queued, 2);
    releaseFirst();
    await exporter.flush();
    await Promise.all([first, second, overflow]);
    assert.equal(exporter.getDiagnostics().exported, 2);
    assert.equal(exporter.getDiagnostics().dropped, 1);
    assert.equal(requestCount, 2);
  } finally {
    releaseFirst();
    server.closeAllConnections();
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});

test("OTLP exporter exposes tail-span timeout while local event persistence remains independent", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.writeHead(200).end("{}"), 250);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const exporter = new OtlpRuntimeExporter(`http://127.0.0.1:${address.port}/v1/traces`, {}, { timeoutMs: 30 });
  const base = { schemaVersion: 1 as const, at: new Date().toISOString(), workspace: "/private", sessionId: "s", runId: "tail-run" };
  try {
    await exporter.record({ ...base, eventId: "tail-start", kind: "run_started", status: "running" });
    await exporter.record({ ...base, eventId: "tail-finish", kind: "run_finished", status: "completed" });
    await exporter.flush();
    assert.equal(exporter.getDiagnostics().timeouts, 1);
    assert.equal(exporter.getDiagnostics().dropped, 1);
    assert.equal(exporter.getDiagnostics().lastError, "collector request timed out after 30ms");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});
