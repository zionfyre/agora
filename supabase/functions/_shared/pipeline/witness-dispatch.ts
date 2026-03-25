// Witness Council — Stage 3: Witness Dispatch
// All witnesses called simultaneously. No cross-pollination.
// Extended thinking enabled for models that support it.

import { getSupabaseClient } from "../supabase.ts";
import { completeWithThinking, isThinkingCapable } from "../openrouter.ts";
import { resolveModel } from "../models.ts";
import { ACTIVE_VOICES } from "../voices.ts";
import type { Testimony, VoiceName } from "../types.ts";

const WITNESS_INSTRUCTION = `You have been presented with the following.

Entry:
{entry_text}

Question:
{formed_question}

Speak to what you witness here. Speak entirely from within your own way of knowing. You are not evaluating other voices. You are not building toward consensus. You are witnessing — offering what you see, from where you stand, as fully and honestly as you are able.`;

function buildWitnessPrompt(entryText: string, formedQuestion: string): string {
  return WITNESS_INSTRUCTION
    .replace("{entry_text}", entryText)
    .replace("{formed_question}", formedQuestion);
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
  entryText: string,
  formedQuestion: string
): Promise<DispatchResult> {
  const supabase = getSupabaseClient();
  const userPrompt = buildWitnessPrompt(entryText, formedQuestion);

  // Dispatch all witnesses in parallel
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

      // Persist testimony immediately — partial results survive if others fail
      const { error } = await supabase
        .from("testimonies")
        .insert(testimony);

      if (error) {
        console.error(`Failed to persist testimony for ${voice.name}: ${error.message}`);
      }

      return { testimony, cost: result.cost };
    })
  );

  // Collect results
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
