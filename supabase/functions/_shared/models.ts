// The Agora Project — Model Configuration
// Tiered model selection per round (per spec modification #3)
//
// Round          | Model tier | Rationale
// ──────────────────────────────────────────────────────────────
// 1 Formation    | Sonnet     | Full epistemic tilt, no synthesis needed
// 2 Steelman     | Sonnet     | Quality matters but not peak reasoning
// 2 Scoring      | Lightweight| Simple 1-5 classification
// 3 Critique     | Sonnet     | Same as formation
// 4 Cartographer | Opus       | Classification quality is critical
// 5 Neologism    | Sonnet     | Creative, not classificatory
// 6 Convergence  | Opus       | Meta-reasoning quality matters

import type { ModelTier, VoiceName } from "./types.ts";

// Pin exact model versions (per concern #6 — pin at launch, don't drift)
// OpenRouter uses short IDs, not date-suffixed versions
export const MODEL_VERSIONS: Record<ModelTier, string> = {
  opus: "anthropic/claude-opus-4.5",
  sonnet: "anthropic/claude-sonnet-4.5",
  lightweight: "anthropic/claude-haiku-4.5",
};

// Voice-to-model overrides for training lineage diversity
// When multiple voices share a tier, we diversify the underlying model
// to get convergence signals across different training regimes
export const VOICE_MODEL_OVERRIDES: Partial<Record<VoiceName, string>> = {
  formal_reasoner: "deepseek/deepseek-r1",
  trickster: "openai/gpt-4o-2024-11-20",
  relational_ontologist: "moonshotai/kimi-k2.5",
  // Aesthetic Reasoner uses the default Sonnet — strong metaphorical reasoning
  // Falsificationist uses the default Sonnet — strong causal reasoning
  // ── Tier 2 voice overrides ──
  east_asian_mind: "upstage/solar-pro-3",
  arab_mind: "mistralai/mistral-saba",
  south_asian_mind: "google/gemini-2.5-pro", // Temporary: Sarvam-M not on OpenRouter. Swap when available.
  latin_american_mind: "mistralai/mistral-medium-3.1", // Temporary: Sabiá-4 not on OpenRouter. Swap when available.
};

// Cost per 1M tokens (USD) — from OpenRouter pricing, updated manually
export const COST_PER_MILLION_TOKENS: Record<
  string,
  { prompt: number; completion: number }
> = {
  "anthropic/claude-opus-4.5": { prompt: 5.0, completion: 25.0 },
  "anthropic/claude-sonnet-4.5": { prompt: 3.0, completion: 15.0 },
  "anthropic/claude-haiku-4.5": { prompt: 1.0, completion: 5.0 },
  "deepseek/deepseek-r1": { prompt: 0.7, completion: 2.5 },
  "openai/gpt-4o-2024-11-20": { prompt: 2.5, completion: 10.0 },
  "moonshotai/kimi-k2.5": { prompt: 0.45, completion: 2.2 },
  // Tier 2 models
  "upstage/solar-pro-3": { prompt: 0.15, completion: 0.6 },
  "mistralai/mistral-saba": { prompt: 0.2, completion: 0.6 },
  "google/gemini-2.5-pro": { prompt: 1.25, completion: 10.0 },
  "mistralai/mistral-medium-3.1": { prompt: 0.4, completion: 2.0 },
};

/**
 * Resolve the actual model ID for a given voice and tier.
 * Voice-specific overrides take precedence over the tier default,
 * but only for sonnet-tier calls (formation, steelman, critique, neologism).
 * Opus and lightweight tiers always use the tier default.
 */
export function resolveModel(
  voice: VoiceName | "cartographer",
  tier: ModelTier
): string {
  // Opus and lightweight always use the tier default
  if (tier !== "sonnet") {
    return MODEL_VERSIONS[tier];
  }

  // For sonnet tier, check voice-specific overrides
  if (voice !== "cartographer" && VOICE_MODEL_OVERRIDES[voice]) {
    return VOICE_MODEL_OVERRIDES[voice]!;
  }

  return MODEL_VERSIONS.sonnet;
}

/**
 * Estimate cost in USD for a given model and token counts.
 * Accounts for Anthropic prompt caching: cached reads at 10%, cache writes at 125%.
 */
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
  cacheWriteTokens = 0
): number {
  const pricing = COST_PER_MILLION_TOKENS[model];
  if (!pricing) return 0;

  // Cached tokens are already included in prompt_tokens count.
  // Subtract them to get the non-cached prompt tokens.
  const regularPromptTokens = promptTokens - cachedTokens - cacheWriteTokens;
  return (
    (Math.max(0, regularPromptTokens) / 1_000_000) * pricing.prompt +
    (cachedTokens / 1_000_000) * pricing.prompt * 0.1 +
    (cacheWriteTokens / 1_000_000) * pricing.prompt * 1.25 +
    (completionTokens / 1_000_000) * pricing.completion
  );
}
