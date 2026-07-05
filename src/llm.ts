import OpenAI from "openai";
import { diagnoseLlmError, extractAssistantText, inferModelProfile } from "./model-adapter.js";

export type LlmOptions = {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  streaming?: boolean;
  onDelta?: (delta: string) => void;
};

const maxRetries = 3;
const retryBaseMs = 1000;

export async function callLLM(prompt: string, options: LlmOptions = {}): Promise<string> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Copy .env.example to .env and configure your API key.");
  }

  const profile = inferModelProfile({ model: options.model, baseURL: options.baseURL });

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      if (options.streaming) {
        return await callLLMStream(prompt, profile, apiKey, options);
      }
      return await callLLMOnce(prompt, profile, apiKey);
    } catch (error) {
      if (attempt === maxRetries || !isRetryableError(error)) {
        throw new Error(diagnoseLlmError(error, { model: profile.model, baseURL: profile.baseURL }));
      }
      const delay = retryBaseMs * Math.pow(2, attempt);
      console.log(`[llm retry ${attempt + 1}/${maxRetries}] waiting ${delay}ms — ${shortError(error)}`);
      await sleep(delay);
    }
  }
  // Unreachable — the loop always throws or returns
  throw new Error("LLM call failed after retries.");
}

async function callLLMOnce(prompt: string, profile: ReturnType<typeof inferModelProfile>, apiKey: string): Promise<string> {
  const client = new OpenAI({ apiKey, baseURL: profile.baseURL });
  const completion = await client.chat.completions.create({
    model: profile.model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You are a minimal ReAct agent. Always respond with strict JSON only. Use either {\"type\":\"action\",\"thought\":\"...\",\"tool\":\"...\",\"input\":{...}} or {\"type\":\"final\",\"answer\":\"...\"}."
      },
      { role: "user", content: prompt }
    ]
  });

  if (!Array.isArray(completion.choices) || completion.choices.length === 0) {
    throw new Error(
      `LLM response did not include chat completion choices.\nModel: ${profile.model}\nBase URL: ${profile.baseURL}`
    );
  }

  const content = extractAssistantText(completion.choices[0]?.message, profile);
  if (!content) {
    throw new Error(
      `LLM response was empty.\nModel: ${profile.model}\nBase URL: ${profile.baseURL}`
    );
  }

  return content;
}

async function callLLMStream(
  prompt: string,
  profile: ReturnType<typeof inferModelProfile>,
  apiKey: string,
  options: LlmOptions
): Promise<string> {
  const client = new OpenAI({ apiKey, baseURL: profile.baseURL });
  const stream = await client.chat.completions.create({
    model: profile.model,
    temperature: 0.2,
    stream: true,
    messages: [
      {
        role: "system",
        content:
          "You are a minimal ReAct agent. Always respond with strict JSON only. Use either {\"type\":\"action\",\"thought\":\"...\",\"tool\":\"...\",\"input\":{...}} or {\"type\":\"final\",\"answer\":\"...\"}."
      },
      { role: "user", content: prompt }
    ]
  });

  let content = "";
  let started = false;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (!delta) continue;
    content += delta;
    options.onDelta?.(delta);

    // Stream partial visible content to user in real-time
    if (!started && content.length > 20) {
      const preview = extractStreamPreview(content);
      if (preview) {
        process.stdout.write(`\n[streaming] ${preview}`);
        started = true;
      }
    }
  }

  if (started) process.stdout.write("\n");
  if (!content) throw new Error("LLM streaming response was empty.");
  return content;
}

function extractStreamPreview(raw: string): string {
  // Try to show the thought or answer content as it arrives
  const thoughtMatch = raw.match(/"thought"\s*:\s*"([^"]{0,80})/);
  if (thoughtMatch) return `thought: ${thoughtMatch[1]}…`;
  const answerMatch = raw.match(/"answer"\s*:\s*"([^"]{0,80})/);
  if (answerMatch) return `answer: ${answerMatch[1]}…`;
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate") || msg.includes("too many requests")) return true;
    if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) return true;
    if (msg.includes("timeout") || msg.includes("econnrefused") || msg.includes("econnreset")) return true;
    if (msg.includes("network") || msg.includes("socket") || msg.includes("connection")) return true;
  }
  return false;
}

function shortError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 120);
  return String(error).slice(0, 120);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assembleStreamDeltas(deltas: string[]): string {
  return deltas.join("");
}
