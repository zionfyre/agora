// Witness Council — Witness Dispatch
// All witnesses called simultaneously. No cross-pollination.
// No question formation. The entry is the entry.
// Extended thinking enabled for models that support it.

import { getSupabaseClient } from "../supabase.ts";
import { completeWithThinking, isThinkingCapable } from "../openrouter.ts";
import { resolveModel } from "../models.ts";
import { ACTIVE_VOICES } from "../voices.ts";
import type { Testimony, VoiceName } from "../types.ts";

function buildWitnessPrompt(entryText: string): string {
  return `${entryText}

Before you speak, sit with what was brought.

Ask yourself:
- What does my tradition already know about this territory?
- What does my tradition see here that others cannot?
- What does my tradition cannot see — or refuse to see?
- What is being assumed here that my tradition would not assume?

Then speak from that place. Fully. Without explanation or apology.
Do not describe your tradition. Speak from within it.`;
}

interface WitnessResult {
  testimony: Testimony;
  cost: {
    model: string;
    voice: string;
    prompt_tokens: number;
    completion_tokens: number;
    estimated_cost_usd: number;
  };
}

interface DispatchResult {
  testimonies: Testimony[];
  partial: boolean;
  costs: WitnessResult["cost"][];
}

export async function dispatchWitnesses(
  deliberationId: string,
  entryText: string
): Promise<DispatchResult> {
  const supabase = getSupabaseClient();
  const userPrompt = buildWitnessPrompt(entryText);

  const results = await Promise.allSettled(
    ACTIVE_VOICES.map(async (voice): Promise<WitnessResult> => {
      const model = resolveModel(voice.name as VoiceName, "sonnet");
      const thinkingEnabled = isThinkingCapable(model);

      console.log(
        `Dispatching witness: ${voice.name} (${model}, thinking=${thinkingEnabled})`
      );

      const result = await completeWithThinking(
        model,
        voice.systemPrompt,
        userPrompt,
        voice.name as VoiceName,
        {
          max_tokens: 4096,
          thinking_budget: thinkingEnabled ? 10000 : undefined,
        }
      );

      const testimony: Testimony = {
        deliberation_id: deliberationId,
        witness_id: voice.name,
        witness_name: voice.displayName,
        model,
        testimony_text: result.content,
        token_count: result.raw_usage.completion_tokens,
        thinking_enabled: thinkingEnabled,
        thinking_token_count: result.thinking_tokens,
      };

      // Persist immediately — partial results survive if others fail
      const { error } = await supabase.from("testimonies").insert(testimony);
      if (error) {
        console.error(`Failed to persist testimony for ${voice.name}: ${error.message}`);
      }

      return { testimony, cost: result.cost };
    })
  );

  const testimonies: Testimony[] = [];
  const costs: WitnessResult["cost"][] = [];
  let failureCount = 0;

  for (const result of results) {
    if (result.status === "fulfilled") {
      testimonies.push(result.value.testimony);
      costs.push(result.value.cost);
    } else {
      failureCount++;
      console.error(`Witness failed: ${result.reason}`);
    }
  }

  const partial = failureCount > 0;
  if (partial) {
    console.warn(
      `Partial council: ${failureCount}/${ACTIVE_VOICES.length} witnesses failed`
    );
  }

  return { testimonies, partial, costs };
}
