// The Agora Project — OpenRouter API Client
// With retry-with-backoff and per-call cost tracking

import { estimateCost } from "./models.ts";
import type { ModelCallCost, VoiceName } from "./types.ts";

interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenRouterResponse {
  id: string;
  choices: { message: { content: string } }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
}

export interface CompletionResult {
  content: string;
  cost: ModelCallCost;
  raw_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Call OpenRouter with retry-with-backoff.
 * Returns the completion text and cost tracking data.
 */
export async function complete(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  voice: VoiceName | "cartographer",
  options?: {
    temperature?: number;
    max_tokens?: number;
  }
): Promise<CompletionResult> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const messages: OpenRouterMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://agora.gadaa.ai",
            "X-Title": "The Agora Project",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: options?.temperature ?? 0.7,
            max_tokens: options?.max_tokens ?? 4096,
          }),
        }
      );

      if (response.status === 429 || response.status >= 500) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `OpenRouter ${response.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenRouter ${response.status}: ${body}`);
      }

      const data: OpenRouterResponse = await response.json();
      const content = data.choices[0]?.message?.content ?? "";
      const usage = data.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };

      return {
        content,
        cost: {
          model,
          voice,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          estimated_cost_usd: estimateCost(
            model,
            usage.prompt_tokens,
            usage.completion_tokens
          ),
        },
        raw_usage: usage,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `OpenRouter error: ${lastError.message}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error("OpenRouter call failed after retries");
}

/**
 * Call OpenRouter expecting a JSON response.
 * Strips markdown code fences if present.
 */
export async function completeJSON<T>(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  voice: VoiceName | "cartographer",
  options?: { temperature?: number; max_tokens?: number }
): Promise<{ data: T; cost: ModelCallCost }> {
  const result = await complete(model, systemPrompt, userPrompt, voice, {
    temperature: options?.temperature ?? 0.3, // Lower temp for structured output
    max_tokens: options?.max_tokens ?? 8192,
  });

  // Extract the first JSON object from the response, regardless of
  // surrounding prose, markdown fences, or trailing text.
  let json = result.content.trim();

  // Strip markdown code fences
  json = json.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");

  // Find the first { ... } or [ ... ] block
  const objStart = json.indexOf("{");
  const arrStart = json.indexOf("[");
  const start =
    objStart >= 0 && (arrStart < 0 || objStart < arrStart)
      ? objStart
      : arrStart;

  if (start < 0) {
    throw new Error(`No JSON found in response: ${json.slice(0, 200)}`);
  }

  // Find the matching closing bracket
  const openChar = json[start];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let end = -1;
  for (let i = start; i < json.length; i++) {
    if (json[i] === openChar) depth++;
    if (json[i] === closeChar) depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }

  if (end < 0) {
    throw new Error(`Unclosed JSON in response: ${json.slice(start, start + 200)}`);
  }

  const data = JSON.parse(json.slice(start, end)) as T;
  return { data, cost: result.cost };
}
