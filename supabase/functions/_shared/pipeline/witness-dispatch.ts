// Witness Council — Witness Dispatch
// All witnesses called simultaneously. No cross-pollination.
// No question formation. The entry is the entry.
// Extended thinking enabled for models that support it.

import { getSupabaseClient } from "../supabase.ts";
import { completeWithThinking, isThinkingCapable } from "../openrouter.ts";
import { resolveModel } from "../models.ts";
import { ACTIVE_VOICES } from "../voices.ts";
import type { Testimony, VoiceName } from "../types.ts";

const WITNESS_TIMEOUT_MS = 30_000;

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

export interface WitnessTimeout {
  witness_id: string;
  model: string;
  timed_out_at: string;
  entry_length: number;
}

interface DispatchResult {
  testimonies: Testimony[];
  partial: boolean;
  costs: WitnessResult["cost"][];
  timeouts: WitnessTimeout[];
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

      const result = await Promise.race([
        completeWithThinking(
          model,
          voice.systemPrompt,
          userPrompt,
          voice.name as VoiceName,
          {
            max_tokens: 4096,
            thinking_budget: thinkingEnabled ? 10000 : undefined,
          }
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("witness_timeout")),
            WITNESS_TIMEOUT_MS
          )
        ),
      ]);

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
  const timeouts: WitnessTimeout[] = [];
  let failureCount = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      testimonies.push(result.value.testimony);
      costs.push(result.value.cost);
    } else {
      failureCount++;
      const voice = ACTIVE_VOICES[i];
      const model = resolveModel(voice.name as VoiceName, "sonnet");
      const isTimeout = result.reason instanceof Error &&
        result.reason.message === "witness_timeout";

      if (isTimeout) {
        console.warn(
          `Witness timed out after ${WITNESS_TIMEOUT_MS}ms: ${voice.name} (${model})`
        );
        timeouts.push({
          witness_id: voice.name,
          model,
          timed_out_at: new Date().toISOString(),
          entry_length: entryText.length,
        });
      } else {
        console.error(`Witness failed: ${voice.name} — ${result.reason}`);
      }
    }
  }

  const partial = failureCount > 0;
  if (partial) {
    console.warn(
      `Partial council: ${failureCount}/${ACTIVE_VOICES.length} witnesses failed (${timeouts.length} timeouts)`
    );
  }

  return { testimonies, partial, costs, timeouts };
}
