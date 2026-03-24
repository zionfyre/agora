// The Agora Project — OpenRouter API Client
// With retry-with-backoff, per-call cost tracking,
// Anthropic prompt caching, and structured output enforcement.

import { estimateCost } from "./models.ts";
import type { ModelCallCost, VoiceName } from "./types.ts";

// ── Message types ─────────────────────────────────────────────────

interface ContentBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
}

interface OpenRouterResponse {
  id: string;
  choices: { message: { content: string } }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
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

// ── Response format types ─────────────────────────────────────────

export interface JsonSchemaFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    strict?: boolean;
    schema: Record<string, unknown>;
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function isAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/");
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// Model-tier-aware timeout: Opus gets extra headroom for long structured output.
// Standard raised to 120s — OpenRouter latency varies under load.
function getTimeoutMs(model: string): number {
  if (model.includes("opus")) return 180_000; // 180s
  if (model.includes("deepseek")) return 150_000; // 150s
  return 120_000; // 120s for sonnet/lightweight
}

/**
 * Build messages array with prompt caching for Anthropic models.
 * The four-layer voice system prompt is identical across rounds for a given
 * voice — marking it as ephemeral lets Anthropic serve it from cache on
 * rounds 2-6. Estimated savings: 30-40% on prompt token costs.
 * Non-Anthropic models ignore cache_control silently.
 */
function buildMessages(
  model: string,
  systemPrompt: string,
  userPrompt: string
): OpenRouterMessage[] {
  if (isAnthropicModel(model)) {
    return [
      {
        role: "system",
        content: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { role: "user", content: userPrompt },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

// ── Core completion ───────────────────────────────────────────────

/**
 * Call OpenRouter with retry-with-backoff.
 * Returns the completion text and cost tracking data.
 * Supports prompt caching (Anthropic) and structured output (json_schema).
 */
export async function complete(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  voice: VoiceName | "cartographer",
  options?: {
    temperature?: number;
    max_tokens?: number;
    response_format?: JsonSchemaFormat;
  }
): Promise<CompletionResult> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const messages = buildMessages(model, systemPrompt, userPrompt);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const timeoutMs = getTimeoutMs(model);
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.max_tokens ?? 4096,
      };

      // Structured output enforcement — eliminates JSON parse failures
      // for Cartographer and scoring calls
      if (options?.response_format) {
        body.response_format = options.response_format;
      }

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
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
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
        const respBody = await response.text();
        throw new Error(`OpenRouter ${response.status}: ${respBody}`);
      }

      const data: OpenRouterResponse = await response.json();
      const content = data.choices[0]?.message?.content ?? "";
      const usage = data.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };

      // Log cache stats — OpenRouter returns cache data under prompt_tokens_details
      const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
      if (cachedTokens > 0) {
        console.log(
          `Prompt cache hit: ${cachedTokens} tokens from cache (${voice})`
        );
      }

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
            usage.completion_tokens,
            cachedTokens,
            cacheWriteTokens
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

// ── JSON completion ───────────────────────────────────────────────

/**
 * Call OpenRouter expecting a JSON response.
 * When a json_schema is provided, uses structured output enforcement —
 * the model cannot return malformed output. The JSON parser below is
 * kept as a fallback for models that don't support response_format.
 */
export async function completeJSON<T>(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  voice: VoiceName | "cartographer",
  options?: {
    temperature?: number;
    max_tokens?: number;
    json_schema?: { name: string; schema: Record<string, unknown> };
  }
): Promise<{ data: T; cost: ModelCallCost }> {
  const responseFormat: JsonSchemaFormat | undefined = options?.json_schema
    ? {
        type: "json_schema",
        json_schema: {
          name: options.json_schema.name,
          strict: true,
          schema: options.json_schema.schema,
        },
      }
    : undefined;

  const result = await complete(model, systemPrompt, userPrompt, voice, {
    temperature: options?.temperature ?? 0.3, // Lower temp for structured output
    max_tokens: options?.max_tokens ?? 8192,
    response_format: responseFormat,
  });

  // Extract the first JSON object from the response, regardless of
  // surrounding prose, markdown fences, or trailing text.
  // With structured output enforcement, this is a passthrough — but kept
  // for robustness with models that don't support response_format.
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
    throw new Error(
      `Unclosed JSON in response: ${json.slice(start, start + 200)}`
    );
  }

  const data = JSON.parse(json.slice(start, end)) as T;
  return { data, cost: result.cost };
}
