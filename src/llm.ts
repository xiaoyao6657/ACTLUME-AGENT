import OpenAI from "openai";

export type LlmOptions = {
  model?: string;
  apiKey?: string;
  baseURL?: string;
};

export async function callLLM(prompt: string, options: LlmOptions = {}): Promise<string> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Copy .env.example to .env and configure your API key.");
  }

  const client = new OpenAI({
    apiKey,
    baseURL: options.baseURL ?? process.env.OPENAI_BASE_URL
  });

  const completion = await client.chat.completions.create({
    model: options.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You are a minimal ReAct agent. Always respond with strict JSON only. Use either {\"type\":\"action\",\"thought\":\"...\",\"tool\":\"...\",\"input\":{...}} or {\"type\":\"final\",\"answer\":\"...\"}."
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });

  if (!Array.isArray(completion.choices) || completion.choices.length === 0) {
    throw new Error(
      [
        "LLM response did not include chat completion choices.",
        `Model: ${options.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini"}`,
        `Base URL: ${options.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}`,
        `Raw response: ${JSON.stringify(completion).slice(0, 2000)}`
      ].join("\n")
    );
  }

  const message = completion.choices[0]?.message;
  const content = message?.content;
  if (!content) {
    const reasoningContent = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
    if (typeof reasoningContent === "string" && reasoningContent.trim()) {
      return reasoningContent;
    }

    throw new Error(`LLM response was empty. Raw response: ${JSON.stringify(completion).slice(0, 2000)}`);
  }

  return content;
}
