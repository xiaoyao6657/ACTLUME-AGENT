import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type EvalProviderProxyBudget = {
  maxRequests: number;
  maxTotalTokens: number;
  maxOutputTokensPerRequest: number;
  maxRequestBytes?: number;
};

export type EvalProviderProxyDiagnostics = {
  forwardedRequests: number;
  blockedRequests: number;
  upstreamHttpErrors: number;
  usageKnownRequests: number;
  usageUnknownRequests: number;
  usageUnknownObservations: EvalProviderUsageUnknownObservation[];
  usageUnknownObservationsDropped: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  budgetStopReason?: "request_limit" | "reported_token_limit";
};

export type EvalProviderUsageUnknownObservation = {
  responseStatus: number | null;
  contentType: string | null;
  responseBytes: number;
  streamRequested: boolean;
  requestAborted: boolean;
  sseDataEvents: number;
  parsedJsonEvents: number;
  usageFieldEvents: number;
  nullUsageEvents: number;
  invalidUsageEvents: number;
  malformedDataEvents: number;
  sawDoneMarker: boolean;
  reason: "usage-field-missing" | "usage-null-only" | "usage-invalid" | "upstream-request-error" | "response-stream-error" | "request-aborted";
};

export type EvalProviderProxy = {
  baseURL: string;
  getDiagnostics(): EvalProviderProxyDiagnostics;
  close(): Promise<void>;
};

export async function startEvalProviderProxy(input: {
  upstreamBaseURL: string;
  upstreamApiKey: string;
  localApiKey: string;
  budget: EvalProviderProxyBudget;
  fetchImpl?: typeof fetch;
}): Promise<EvalProviderProxy> {
  if (!input.upstreamApiKey || !input.localApiKey) throw new Error("Eval proxy keys must not be empty.");
  for (const [name, value] of Object.entries(input.budget)) {
    if (name === "maxRequestBytes" && value === undefined) continue;
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`Eval proxy ${name} must be a positive integer.`);
  }
  const upstreamBase = new URL(input.upstreamBaseURL);
  if (!/^https?:$/.test(upstreamBase.protocol)) throw new Error("Eval proxy upstream must use HTTP or HTTPS.");
  upstreamBase.username = "";
  upstreamBase.password = "";
  upstreamBase.search = "";
  upstreamBase.hash = "";
  const basePath = upstreamBase.pathname.replace(/\/+$/, "");
  const maxRequestBytes = input.budget.maxRequestBytes ?? 1_048_576;
  const fetchImpl = input.fetchImpl ?? fetch;
  const activeRequests = new Set<AbortController>();
  const diagnostics: EvalProviderProxyDiagnostics = {
    forwardedRequests: 0, blockedRequests: 0, upstreamHttpErrors: 0,
    usageKnownRequests: 0, usageUnknownRequests: 0,
    usageUnknownObservations: [], usageUnknownObservationsDropped: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0
  };

  const server = createServer(async (request, response) => {
    const localPath = request.url?.split("?", 1)[0] ?? "";
    const suffix = localPath.startsWith(basePath) ? localPath.slice(basePath.length) : "";
    if (request.method !== "POST" || suffix !== "/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Eval proxy only forwards chat completions." } }));
      return;
    }
    const authorization = request.headers.authorization ?? "";
    if (authorization !== `Bearer ${input.localApiKey}`) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid local Eval proxy credential." } }));
      return;
    }
    let rawBody: string;
    try { rawBody = await readBody(request, maxRequestBytes); }
    catch (error) {
      response.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: safeError(error) } }));
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!isRecord(parsed)) throw new Error("Request body must be a JSON object.");
      body = parsed;
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: safeError(error) } }));
      return;
    }
    if (diagnostics.forwardedRequests >= input.budget.maxRequests) {
      diagnostics.blockedRequests += 1;
      diagnostics.budgetStopReason = "request_limit";
      response.writeHead(429, { "content-type": "application/json", "retry-after": "0" })
        .end(JSON.stringify({ error: { message: "Eval request budget exhausted; no upstream request was made." } }));
      return;
    }
    if (diagnostics.usageKnownRequests > 0 && diagnostics.totalTokens >= input.budget.maxTotalTokens) {
      diagnostics.blockedRequests += 1;
      diagnostics.budgetStopReason = "reported_token_limit";
      response.writeHead(429, { "content-type": "application/json", "retry-after": "0" })
        .end(JSON.stringify({ error: { message: "Eval reported-token budget exhausted; no upstream request was made." } }));
      return;
    }

    const outputLimit = input.budget.maxOutputTokensPerRequest;
    if (typeof body.max_tokens === "number") body.max_tokens = Math.min(body.max_tokens, outputLimit);
    else if (typeof body.max_completion_tokens === "number") body.max_completion_tokens = Math.min(body.max_completion_tokens, outputLimit);
    else body.max_tokens = outputLimit;

    const controller = new AbortController();
    activeRequests.add(controller);
    let requestForwarded = false;
    let requestUsageRecorded = false;
    let upstreamResponseStatus: number | null = null;
    let upstreamContentType: string | null = null;
    let streamFailureObservation: EvalProviderUsageUnknownObservation | undefined;
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    diagnostics.forwardedRequests += 1;
    requestForwarded = true;
    const target = new URL(upstreamBase.href);
    target.pathname = `${basePath}${suffix}`;
    const query = request.url?.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
    target.search = query;
    try {
      const upstream = await fetchImpl(target, {
        method: "POST",
        headers: {
          "content-type": request.headers["content-type"] ?? "application/json",
          accept: request.headers.accept ?? "application/json",
          authorization: `Bearer ${input.upstreamApiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      upstreamResponseStatus = upstream.status;
      upstreamContentType = upstream.headers.get("content-type");
      if (upstream.status >= 400) diagnostics.upstreamHttpErrors += 1;
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        ...(upstream.headers.get("cache-control") ? { "cache-control": upstream.headers.get("cache-control")! } : {})
      });
      const result = await forwardAndReadUsage(upstream, response, {
        responseStatus: upstream.status,
        contentType: upstreamContentType,
        streamRequested: body.stream === true
      }, controller.signal, (observation) => { streamFailureObservation = observation; });
      const usage = result.usage;
      if (usage) {
        diagnostics.usageKnownRequests += 1;
        diagnostics.inputTokens += usage.input;
        diagnostics.outputTokens += usage.output;
        diagnostics.totalTokens += usage.total;
        requestUsageRecorded = true;
      } else {
        diagnostics.usageUnknownRequests += 1;
        recordUnknownUsageObservation(diagnostics, result.observation);
        requestUsageRecorded = true;
      }
    } catch (error) {
      if (requestForwarded && !requestUsageRecorded) {
        diagnostics.usageUnknownRequests += 1;
        const observation = streamFailureObservation ?? {
          responseStatus: upstreamResponseStatus,
          contentType: upstreamContentType,
          responseBytes: 0,
          streamRequested: body.stream === true,
          requestAborted: controller.signal.aborted,
          sseDataEvents: 0,
          parsedJsonEvents: 0,
          usageFieldEvents: 0,
          nullUsageEvents: 0,
          invalidUsageEvents: 0,
          malformedDataEvents: 0,
          sawDoneMarker: false,
          reason: controller.signal.aborted
            ? "request-aborted" as const
            : upstreamResponseStatus === null ? "upstream-request-error" as const : "response-stream-error" as const
        };
        recordUnknownUsageObservation(diagnostics, observation);
      }
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      if (!response.writableEnded) response.end(JSON.stringify({ error: { message: controller.signal.aborted ? "Eval proxy request aborted." : "Eval proxy upstream request failed." } }));
    } finally {
      activeRequests.delete(controller);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("Eval provider proxy failed to bind.");
  const localPath = `${basePath}`;
  return {
    baseURL: `http://127.0.0.1:${address.port}${localPath}`,
    getDiagnostics: () => ({ ...diagnostics }),
    close: async () => {
      for (const controller of activeRequests) controller.abort();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) throw new Error("Request body exceeded the configured byte limit.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type UsageObservationInput = Pick<EvalProviderUsageUnknownObservation, "responseStatus" | "contentType" | "streamRequested">;
type UsageResponseResult = {
  usage?: { input: number; output: number; total: number };
  observation: EvalProviderUsageUnknownObservation;
};

async function forwardAndReadUsage(
  upstream: Response,
  response: import("node:http").ServerResponse,
  input: UsageObservationInput,
  signal: AbortSignal,
  onStreamFailure: (observation: EvalProviderUsageUnknownObservation) => void
): Promise<UsageResponseResult> {
  const observation = {
    ...input,
    responseBytes: 0,
    requestAborted: false,
    sseDataEvents: 0,
    parsedJsonEvents: 0,
    usageFieldEvents: 0,
    nullUsageEvents: 0,
    invalidUsageEvents: 0,
    malformedDataEvents: 0,
    sawDoneMarker: false
  };
  if (!upstream.body) {
    response.end();
    return { observation: finishUsageObservation(observation) };
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let raw = "";
  let usage: { input: number; output: number; total: number } | undefined;
  const consumeData = (value: string): void => {
    observation.sseDataEvents += 1;
    if (value === "[DONE]") {
      observation.sawDoneMarker = true;
      return;
    }
    const parsed = inspectUsageValue(value);
    if (!parsed.validJson) {
      observation.malformedDataEvents += 1;
      return;
    }
    observation.parsedJsonEvents += 1;
    if (!parsed.hasUsage) return;
    observation.usageFieldEvents += 1;
    if (parsed.nullUsage) observation.nullUsageEvents += 1;
    else if (parsed.usage) usage = parsed.usage;
    else observation.invalidUsageEvents += 1;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      observation.responseBytes += value.byteLength;
      response.write(value);
      const text = decoder.decode(value, { stream: true });
      raw += text;
      carry += text;
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        consumeData(line.slice(5).trim());
      }
      if (raw.length > 16 * 1024 * 1024) throw new Error("Upstream response exceeded the Eval proxy buffer limit.");
    }
    carry += decoder.decode();
    if (carry.startsWith("data:")) consumeData(carry.slice(5).trim());
    if (observation.sseDataEvents === 0) {
      const parsed = inspectUsageValue(raw);
      if (parsed.validJson) {
        observation.parsedJsonEvents += 1;
        if (parsed.hasUsage) {
          observation.usageFieldEvents += 1;
          if (parsed.nullUsage) observation.nullUsageEvents += 1;
          else if (parsed.usage) usage = parsed.usage;
          else observation.invalidUsageEvents += 1;
        }
      } else if (raw.trim()) observation.malformedDataEvents += 1;
    }
    response.end();
    return { ...(usage ? { usage } : {}), observation: finishUsageObservation(observation) };
  } catch (error) {
    observation.requestAborted = signal.aborted;
    // Some OpenAI-compatible clients cancel the HTTP body immediately after
    // receiving the terminal SSE marker. Treat that as a protocol-complete
    // response; otherwise the final request is misreported as a transport
    // failure even though the provider sent [DONE].
    if (signal.aborted && observation.sawDoneMarker) {
      await reader.cancel().catch(() => undefined);
      if (!response.writableEnded) response.end();
      return { ...(usage ? { usage } : {}), observation: finishUsageObservation(observation) };
    }
    onStreamFailure({
      ...observation,
      reason: signal.aborted ? "request-aborted" : "response-stream-error"
    });
    await reader.cancel().catch(() => undefined);
    if (!response.writableEnded) response.end();
    throw error;
  }
}

function inspectUsageValue(raw: string): {
  validJson: boolean;
  hasUsage: boolean;
  nullUsage: boolean;
  usage?: { input: number; output: number; total: number };
} {
  if (!raw || raw === "[DONE]") return { validJson: raw === "[DONE]", hasUsage: false, nullUsage: false };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { validJson: false, hasUsage: false, nullUsage: false }; }
  if (!isRecord(value) || !Object.hasOwn(value, "usage")) return { validJson: true, hasUsage: false, nullUsage: false };
  if (value.usage === null) return { validJson: true, hasUsage: true, nullUsage: true };
  if (!isRecord(value.usage)) return { validJson: true, hasUsage: true, nullUsage: false };
  const usage = value.usage;
  const input = numeric(usage.prompt_tokens) ?? numeric(usage.input_tokens);
  const output = numeric(usage.completion_tokens) ?? numeric(usage.output_tokens);
  const total = numeric(usage.total_tokens) ?? (input !== undefined && output !== undefined ? input + output : undefined);
  if (input === undefined || output === undefined || total === undefined) return { validJson: true, hasUsage: true, nullUsage: false };
  return { validJson: true, hasUsage: true, nullUsage: false, usage: { input, output, total } };
}

function finishUsageObservation(
  observation: Omit<EvalProviderUsageUnknownObservation, "reason">
): EvalProviderUsageUnknownObservation {
  const reason = observation.usageFieldEvents === 0
    ? "usage-field-missing"
    : observation.nullUsageEvents > 0 && observation.invalidUsageEvents === 0
      ? "usage-null-only"
      : "usage-invalid";
  return { ...observation, reason };
}

function recordUnknownUsageObservation(
  diagnostics: EvalProviderProxyDiagnostics,
  observation: EvalProviderUsageUnknownObservation
): void {
  if (diagnostics.usageUnknownObservations.length < 16) diagnostics.usageUnknownObservations.push(observation);
  else diagnostics.usageUnknownObservationsDropped += 1;
}

function numeric(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeError(error: unknown): string { return error instanceof Error ? error.message : "Invalid request."; }
