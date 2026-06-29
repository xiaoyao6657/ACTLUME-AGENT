export type ModelProvider = "openai" | "deepseek" | "ollama" | "openai-compatible";

export type ModelProfile = {
  provider: ModelProvider;
  model: string;
  baseURL: string;
  supportsReasoningContent: boolean;
  prefersStrictJsonPrompt: boolean;
  estimatedContextTokens: number;
};

export type LlmErrorContext = {
  model: string;
  baseURL: string;
};

export function inferModelProfile(params: { model?: string; baseURL?: string }): ModelProfile {
  const model = params.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const baseURL = params.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const provider = inferProvider(model, baseURL);

  return {
    provider,
    model,
    baseURL,
    supportsReasoningContent: provider === "deepseek",
    prefersStrictJsonPrompt: true,
    estimatedContextTokens: estimateContextTokens(model)
  };
}

export function modelProfileForPrompt(profile: ModelProfile): string {
  return [
    "Model profile:",
    `Provider: ${profile.provider}`,
    `Model: ${profile.model}`,
    `Base URL: ${profile.baseURL}`,
    `Estimated context tokens: ${profile.estimatedContextTokens}`,
    `Reasoning content fallback: ${profile.supportsReasoningContent}`
  ].join("\n");
}

export function extractAssistantText(message: unknown, profile: ModelProfile): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }

  const reasoningContent = record.reasoning_content;
  if (profile.supportsReasoningContent && typeof reasoningContent === "string" && reasoningContent.trim()) {
    return reasoningContent;
  }

  return undefined;
}

export function diagnoseLlmError(error: unknown, context: LlmErrorContext): string {
  const err = error as {
    status?: number;
    code?: string;
    type?: string;
    message?: string;
    response?: { status?: number; text?: unknown; data?: unknown };
  };
  const status = err.status ?? err.response?.status;
  const message = String(err.message ?? error);
  const raw = stringifyErrorPayload(error);
  const lines = ["LLM request failed.", `Model: ${context.model}`, `Base URL: ${context.baseURL}`];

  if (status === 401 || /invalid api key|authentication|unauthorized|401/i.test(message)) {
    lines.push("Diagnosis: API key is missing, invalid, expired, or not accepted by this endpoint.");
    lines.push("Check OPENAI_API_KEY or apiKey in your actlume config.");
  } else if (status === 403) {
    lines.push("Diagnosis: The API key is valid but does not have permission for this model or endpoint.");
  } else if (status === 404 || /model.*not.*found|not found|404/i.test(message)) {
    lines.push("Diagnosis: The model name or base URL is likely incorrect.");
  } else if (status === 429 || /rate limit|quota|429/i.test(message)) {
    lines.push("Diagnosis: Rate limit or quota exceeded.");
  } else if (status && status >= 500) {
    lines.push("Diagnosis: Upstream server or gateway error.");
  } else if (looksLikeHtml(raw) || looksLikeHtml(message)) {
    lines.push("Diagnosis: The base URL returned an HTML page, not an OpenAI-compatible JSON API.");
    lines.push("Check that OPENAI_BASE_URL points to an API endpoint ending with something like /v1.");
  } else if (/choices/i.test(message)) {
    lines.push("Diagnosis: The endpoint responded, but not with OpenAI-compatible chat completion choices.");
  } else {
    lines.push("Diagnosis: Unknown OpenAI-compatible API error.");
  }

  lines.push(`Raw error: ${raw.slice(0, 2000)}`);
  return lines.join("\n");
}

function inferProvider(model: string, baseURL: string): ModelProvider {
  const haystack = `${model}\n${baseURL}`.toLowerCase();
  if (haystack.includes("deepseek")) {
    return "deepseek";
  }
  if (haystack.includes("ollama") || baseURL.includes("localhost:11434")) {
    return "ollama";
  }
  if (baseURL.includes("api.openai.com")) {
    return "openai";
  }
  return "openai-compatible";
}

function estimateContextTokens(model: string): number {
  const lower = model.toLowerCase();
  if (lower.includes("gpt-4.1") || lower.includes("gpt-4o") || lower.includes("deepseek")) {
    return 128000;
  }
  if (lower.includes("mini")) {
    return 64000;
  }
  return 32000;
}

function stringifyErrorPayload(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & Record<string, unknown>;
    return JSON.stringify(
      {
        name: error.name,
        message: error.message,
        status: extra.status,
        code: extra.code,
        type: extra.type,
        response: extra.response
      },
      null,
      2
    );
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function looksLikeHtml(value: string): boolean {
  return /<!doctype html|<html[\s>]/i.test(value);
}
