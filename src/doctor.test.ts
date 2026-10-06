import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { formatDoctorReport, runDoctor } from "./doctor.js";

test("doctor reports local runtime and storage checks without probing provider or leaking credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "actlume-doctor-"));
  try {
    const piCliPath = join(root, "pi-version.mjs");
    await writeFile(piCliPath, 'console.log("Pi test version");\n');
    const report = await runDoctor({
      workspace: root,
      memoryDir: join(root, ".agent-memory"),
      projectRoot: root,
      piCliPath,
      model: "fixture-model",
      baseURL: "https://provider.example/v1",
      apiKey: "never-print-this-key"
    });

    assert.equal(report.exitCode, 0);
    assert.equal(report.checks.find((item) => item.name === "Pi CLI")?.status, "ok");
    assert.equal(report.checks.find((item) => item.name === "Shell startup")?.status, "ok");
    assert.equal(report.checks.find((item) => item.name === "Data storage")?.status, "ok");
    assert.equal(report.checks.find((item) => item.name === "Provider connection")?.status, "unknown");
    assert.doesNotMatch(formatDoctorReport(report), /never-print-this-key/);
    assert.deepEqual((await readdir(join(root, ".agent-memory"))).filter((name) => name.startsWith(".doctor-")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit provider probe sends one minimal request and reports only HTTP status", async () => {
  let requestPath = "";
  let requestAuthorization = "";
  let requestBody: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    requestPath = request.url ?? "";
    requestAuthorization = request.headers.authorization ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(join(tmpdir(), "actlume-doctor-provider-"));
  try {
    const piCliPath = join(root, "pi-version.mjs");
    await writeFile(piCliPath, 'console.log("Pi test version");\n');
    const apiKey = "doctor-probe-test-key";
    const report = await runDoctor({
      workspace: root,
      memoryDir: join(root, ".agent-memory"),
      projectRoot: root,
      piCliPath,
      model: "fixture-model",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKey,
      probeProvider: true
    });
    const provider = report.checks.find((item) => item.name === "Provider connection");
    assert.equal(provider?.status, "ok");
    assert.equal(requestPath, "/v1/chat/completions");
    assert.equal(requestAuthorization, `Bearer ${apiKey}`);
    assert.equal(requestBody.model, "fixture-model");
    assert.equal(requestBody.max_tokens, 1);
    assert.doesNotMatch(formatDoctorReport(report), new RegExp(apiKey));
  } finally {
    await rm(root, { recursive: true, force: true });
    server.close();
  }
});
