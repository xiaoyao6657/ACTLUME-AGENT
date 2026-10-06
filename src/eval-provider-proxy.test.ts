import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { startEvalProviderProxy } from "./eval-provider-proxy.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind.");
  return `http://127.0.0.1:${address.port}/v1`;
}

test("Eval provider proxy caps per-response output and blocks new upstream calls at the reported-token budget", async () => {
  let forwarded = 0;
  let auth = "";
  let maxTokens: unknown;
  const upstream = createServer(async (request, response) => {
    forwarded += 1;
    auth = request.headers.authorization ?? "";
    const body = JSON.parse(await readRequest(request)) as Record<string, unknown>;
    maxTokens = body.max_tokens;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "mock", usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } }));
  });
  const upstreamURL = await listen(upstream);
  const proxy = await startEvalProviderProxy({ upstreamBaseURL: upstreamURL, upstreamApiKey: "upstream-secret", localApiKey: "local-secret", budget: { maxRequests: 3, maxTotalTokens: 10, maxOutputTokensPerRequest: 64 } });
  try {
    const first = await fetch(`${proxy.baseURL}/chat/completions`, { method: "POST", headers: { authorization: "Bearer local-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "m", max_tokens: 8000 }) });
    assert.equal(first.status, 200);
    assert.equal(auth, "Bearer upstream-secret");
    assert.equal(maxTokens, 64);
    const second = await fetch(`${proxy.baseURL}/chat/completions`, { method: "POST", headers: { authorization: "Bearer local-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "m" }) });
    assert.equal(second.status, 429);
    assert.equal(forwarded, 1);
    assert.deepEqual(proxy.getDiagnostics(), {
      forwardedRequests: 1, blockedRequests: 1, upstreamHttpErrors: 0,
      usageKnownRequests: 1, usageUnknownRequests: 0,
      usageUnknownObservations: [], usageUnknownObservationsDropped: 0,
      inputTokens: 4, outputTokens: 6, totalTokens: 10, budgetStopReason: "reported_token_limit"
    });
  } finally {
    await proxy.close();
    await closeServer(upstream);
  }
});

test("Eval provider proxy enforces the request ceiling when the provider omits usage", async () => {
  let forwarded = 0;
  const upstream = createServer((_request, response) => {
    forwarded += 1;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "mock", choices: [] }));
  });
  const upstreamURL = await listen(upstream);
  const proxy = await startEvalProviderProxy({ upstreamBaseURL: upstreamURL, upstreamApiKey: "upstream-secret", localApiKey: "local-secret", budget: { maxRequests: 1, maxTotalTokens: 100, maxOutputTokensPerRequest: 32 } });
  try {
    const invoke = () => fetch(`${proxy.baseURL}/chat/completions`, { method: "POST", headers: { authorization: "Bearer local-secret", "content-type": "application/json" }, body: JSON.stringify({ model: "m" }) });
    assert.equal((await invoke()).status, 200);
    assert.equal((await invoke()).status, 429);
    assert.equal(forwarded, 1);
    assert.equal(proxy.getDiagnostics().usageUnknownRequests, 1);
    assert.equal(proxy.getDiagnostics().budgetStopReason, "request_limit");
    assert.deepEqual(proxy.getDiagnostics().usageUnknownObservations[0], {
      responseStatus: 200,
      contentType: "application/json",
      responseBytes: Buffer.byteLength(JSON.stringify({ id: "mock", choices: [] })),
      streamRequested: false,
      requestAborted: false,
      sseDataEvents: 0,
      parsedJsonEvents: 1,
      usageFieldEvents: 0,
      nullUsageEvents: 0,
      invalidUsageEvents: 0,
      malformedDataEvents: 0,
      sawDoneMarker: false,
      reason: "usage-field-missing"
    });
    assert.equal("responseBody" in proxy.getDiagnostics().usageUnknownObservations[0]!, false);
  } finally {
    await proxy.close();
    await closeServer(upstream);
  }
});

test("Eval provider proxy explains a streamed usage-null response without retaining response content", async () => {
  const body = [
    `data: ${JSON.stringify({ id: "mock", choices: [{ delta: { content: "secret response text" } }], usage: null })}`,
    "data: [DONE]",
    ""
  ].join("\n\n");
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }).end(body);
  });
  const upstreamURL = await listen(upstream);
  const proxy = await startEvalProviderProxy({
    upstreamBaseURL: upstreamURL,
    upstreamApiKey: "upstream-secret",
    localApiKey: "local-secret",
    budget: { maxRequests: 1, maxTotalTokens: 100, maxOutputTokensPerRequest: 32 }
  });
  try {
    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true })
    });
    assert.equal(await response.text(), body);
    assert.deepEqual(proxy.getDiagnostics().usageUnknownObservations[0], {
      responseStatus: 200,
      contentType: "text/event-stream",
      responseBytes: Buffer.byteLength(body),
      streamRequested: true,
      requestAborted: false,
      sseDataEvents: 2,
      parsedJsonEvents: 1,
      usageFieldEvents: 1,
      nullUsageEvents: 1,
      invalidUsageEvents: 0,
      malformedDataEvents: 0,
      sawDoneMarker: true,
      reason: "usage-null-only"
    });
    assert.equal(JSON.stringify(proxy.getDiagnostics()).includes("secret response text"), false);
  } finally {
    await proxy.close();
    await closeServer(upstream);
  }
});

test("Eval provider proxy treats downstream cancellation after SSE DONE as protocol completion", async () => {
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let proxyClosed = false;
  const body = `data: ${JSON.stringify({ id: "mock", choices: [], usage: null })}\n\ndata: [DONE]\n\n`;
  const proxy = await startEvalProviderProxy({
    upstreamBaseURL: "https://provider.invalid/v1",
    upstreamApiKey: "upstream-secret",
    localApiKey: "local-secret",
    budget: { maxRequests: 1, maxTotalTokens: 100, maxOutputTokensPerRequest: 32 },
    fetchImpl: async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(new TextEncoder().encode(body));
        init?.signal?.addEventListener("abort", () => {
          try { controller.error(new Error("downstream cancelled after DONE")); } catch { /* consumer already cancelled */ }
        }, { once: true });
      }
    }), { status: 200, headers: { "content-type": "text/event-stream" } })
  });
  try {
    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true }),
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value).includes("[DONE]"), true);
    await proxy.close();
    proxyClosed = true;
    const observation = proxy.getDiagnostics().usageUnknownObservations[0];
    assert.equal(observation?.requestAborted, true);
    assert.equal(observation?.sawDoneMarker, true);
    assert.equal(observation?.reason, "usage-null-only");
    assert.equal(proxy.getDiagnostics().usageUnknownRequests, 1);
  } finally {
    if (!proxyClosed) await proxy.close();
    try { upstreamController?.error(new Error("test cleanup")); } catch { /* stream may already be cancelled */ }
  }
});

test("Eval provider proxy distinguishes an invalid usage object from a missing usage field", async () => {
  const body = `data: ${JSON.stringify({ id: "mock", choices: [], usage: { prompt_tokens: "4", completion_tokens: 2 } })}\n\n`;
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }).end(body);
  });
  const upstreamURL = await listen(upstream);
  const proxy = await startEvalProviderProxy({
    upstreamBaseURL: upstreamURL,
    upstreamApiKey: "upstream-secret",
    localApiKey: "local-secret",
    budget: { maxRequests: 1, maxTotalTokens: 100, maxOutputTokensPerRequest: 32 }
  });
  try {
    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true })
    });
    await response.text();
    const observation = proxy.getDiagnostics().usageUnknownObservations[0];
    assert.equal(observation?.usageFieldEvents, 1);
    assert.equal(observation?.invalidUsageEvents, 1);
    assert.equal(observation?.reason, "usage-invalid");
  } finally {
    await proxy.close();
    await closeServer(upstream);
  }
});

test("Eval provider proxy counts a forwarded request with a network failure as unknown usage", async () => {
  const proxy = await startEvalProviderProxy({
    upstreamBaseURL: "https://provider.invalid/v1",
    upstreamApiKey: "upstream-secret",
    localApiKey: "local-secret",
    budget: { maxRequests: 1, maxTotalTokens: 100, maxOutputTokensPerRequest: 32 },
    fetchImpl: async () => { throw new Error("network failure"); }
  });
  try {
    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "m" })
    });
    assert.equal(response.status, 502);
    assert.equal(proxy.getDiagnostics().forwardedRequests, 1);
    assert.equal(proxy.getDiagnostics().usageKnownRequests, 0);
    assert.equal(proxy.getDiagnostics().usageUnknownRequests, 1);
    assert.deepEqual(proxy.getDiagnostics().usageUnknownObservations[0], {
      responseStatus: null,
      contentType: null,
      responseBytes: 0,
      streamRequested: false,
      requestAborted: false,
      sseDataEvents: 0,
      parsedJsonEvents: 0,
      usageFieldEvents: 0,
      nullUsageEvents: 0,
      invalidUsageEvents: 0,
      malformedDataEvents: 0,
      sawDoneMarker: false,
      reason: "upstream-request-error"
    });
  } finally {
    await proxy.close();
  }
});

test("Eval provider proxy records safe response metadata when an upstream stream errors", async () => {
  const proxy = await startEvalProviderProxy({
    upstreamBaseURL: "https://provider.invalid/v1",
    upstreamApiKey: "upstream-secret",
    localApiKey: "local-secret",
    budget: { maxRequests: 1, maxTotalTokens: 100, maxOutputTokensPerRequest: 32 },
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("unretained upstream body text")); }
    }), { status: 200, headers: { "content-type": "text/event-stream" } })
  });
  try {
    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true })
    });
    assert.equal(response.status, 200);
    await response.text();
    const diagnostics = proxy.getDiagnostics();
    assert.equal(diagnostics.usageUnknownRequests, 1);
    assert.deepEqual(diagnostics.usageUnknownObservations[0], {
      responseStatus: 200,
      contentType: "text/event-stream",
      responseBytes: 0,
      streamRequested: true,
      requestAborted: false,
      sseDataEvents: 0,
      parsedJsonEvents: 0,
      usageFieldEvents: 0,
      nullUsageEvents: 0,
      invalidUsageEvents: 0,
      malformedDataEvents: 0,
      sawDoneMarker: false,
      reason: "response-stream-error"
    });
    assert.equal(JSON.stringify(diagnostics).includes("unretained upstream body text"), false);
  } finally {
    await proxy.close();
  }
});

async function readRequest(request: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
