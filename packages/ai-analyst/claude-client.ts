import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getClaudeClient(): Anthropic {
  if (client) return client;
  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  return client;
}

/**
 * Call Claude with structured system + user messages.
 * Returns the text content of the response.
 */
export async function askClaude(params: {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const claude = getClaudeClient();

  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: params.maxTokens ?? 4096,
    temperature: params.temperature ?? 0.3,
    system: params.system,
    messages: [{ role: "user", content: params.prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in Claude response");
  }

  return textBlock.text;
}

/**
 * Call Claude expecting a JSON response. Parses and returns the object.
 */
export async function askClaudeJson<T = unknown>(params: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<T> {
  const text = await askClaude({
    ...params,
    system: params.system + "\n\nIMPORTANT: Respond ONLY with valid JSON. No markdown, no code fences, no explanation outside the JSON.",
  });

  // Strip any markdown code fences that might slip through
  const cleaned = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  return JSON.parse(cleaned) as T;
}
