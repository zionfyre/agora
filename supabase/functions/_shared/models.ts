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
export const MODEL_VERSIONS: Record<ModelTier, string> = {
  opus: "anthropic/claude-opus-4-20250514",
  sonnet: "anthropic/claude-sonnet-4-20250514",
  lightweight: "anthropic/claude-haiku-4-20250414",
};

// Voice-to-model overrides for training lineage diversity
// When multiple voices share a tier, we diversify the underlying model
// to get convergence signals across different training regimes
export const VOICE_MODEL_OVERRIDES: Partial<Record<VoiceName, string>> = {
  formal_reasoner: "deepseek/deepseek-r1",
  trickster: "openai/gpt-4o-2024-11-20",
  // Aesthetic Reasoner uses the default Sonnet — strong metaphorical reasoning
  // Falsificationist uses the default Sonnet — strong causal reasoning
};

// Cost per 1M tokens (USD) — used for estimation, updated manually
export const COST_PER_MILLION_TOKENS: Record<
  string,
  { prompt: number; completion: number }
> = {
  "anthropic/claude-opus-4-20250514": { prompt: 15.0, completion: 75.0 },
  "anthropic/claude-sonnet-4-20250514": { prompt: 3.0, completion: 15.0 },
  "anthropic/claude-haiku-4-20250414": { prompt: 0.8, completion: 4.0 },
  "deepseek/deepseek-r1": { prompt: 0.55, completion: 2.19 },
  "openai/gpt-4o-2024-11-20": { prompt: 2.5, completion: 10.0 },
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
 */
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = COST_PER_MILLION_TOKENS[model];
  if (!pricing) return 0;
  return (
    (promptTokens / 1_000_000) * pricing.prompt +
    (completionTokens / 1_000_000) * pricing.completion
  );
}
