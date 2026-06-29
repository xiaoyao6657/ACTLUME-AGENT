import OpenAI from "openai";
import { diagnoseLlmError, extractAssistantText, inferModelProfile } from "./model-adapter.js";

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

  const profile = inferModelProfile({ model: options.model, baseURL: options.baseURL });
  const client = new OpenAI({
    apiKey,
    baseURL: profile.baseURL
  });

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: profile.model,
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
  } catch (error) {
    throw new Error(diagnoseLlmError(error, { model: profile.model, baseURL: profile.baseURL }));
  }

  if (!Array.isArray(completion.choices) || completion.choices.length === 0) {
    throw new Error(
      [
        "LLM response did not include chat completion choices.",
        `Model: ${profile.model}`,
        `Base URL: ${profile.baseURL}`,
        `Raw response: ${JSON.stringify(completion).slice(0, 2000)}`
      ].join("\n")
    );
  }

  const message = completion.choices[0]?.message;
  const content = extractAssistantText(message, profile);
  if (!content) {
    throw new Error(
      [
        "LLM response was empty.",
        `Model: ${profile.model}`,
        `Base URL: ${profile.baseURL}`,
        `Raw response: ${JSON.stringify(completion).slice(0, 2000)}`
      ].join("\n")
    );
  }

  return content;
}
