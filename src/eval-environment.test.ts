import test from "node:test";
import assert from "node:assert/strict";
import { removeProviderSecrets } from "./eval-environment.js";

test("real-model fixture workers do not inherit provider credentials", () => {
  const environment = {
    PATH: "tools",
    npm_execpath: "npm-cli.js",
    OPENAI_API_KEY: "provider-secret",
    OPENAI_BASE_URL: "https://provider.invalid/v1",
    DEEPSEEK_API_KEY: "other-provider-secret",
    ACTLUME_EVAL_WORKER_CONFIG: "local-proxy-only"
  };
  assert.deepEqual(removeProviderSecrets(environment), {
    PATH: "tools",
    npm_execpath: "npm-cli.js",
    ACTLUME_EVAL_WORKER_CONFIG: "local-proxy-only"
  });
});
