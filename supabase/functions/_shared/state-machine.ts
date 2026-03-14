// The Agora Project — Round-based State Machine
// Each round is a separate invocation. State persisted to DB between rounds.
// On completion of a round, triggers the next round via self-invocation.

import { getSupabaseClient } from "./supabase.ts";
import { CostTracker } from "./cost-tracker.ts";
import { runFormation } from "./rounds/formation.ts";
import { runSteelman } from "./rounds/steelman.ts";
import { runCritique } from "./rounds/critique.ts";
import { runCartographer } from "./rounds/cartographer.ts";
import { runNeologism } from "./rounds/neologism.ts";
import { runConvergence } from "./rounds/convergence.ts";
import type {
  DeliberationRow,
  DeliberationGraph,
  RoundNumber,
  DeliberationStatus,
  Round,
} from "./types.ts";
import { STATUS_FOR_ROUND } from "./types.ts";

const ROUND_HANDLERS: Record<
  RoundNumber,
  (
    deliberation: DeliberationRow,
    costTracker: CostTracker
  ) => Promise<Partial<DeliberationGraph>>
> = {
  1: runFormation,
  2: runSteelman,
  3: runCritique,
  4: runCartographer,
  5: runNeologism,
  6: runConvergence,
};

/**
 * Advance a deliberation to its next round.
 * Reads current state, runs the appropriate round handler,
 * persists results, and triggers the next round.
 */
export async function advanceDeliberation(
  deliberationId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();

  // 1. Read current state
  const { data: row, error: fetchError } = await supabase
    .from("deliberations")
    .select("*")
    .eq("id", deliberationId)
    .single();

  if (fetchError || !row) {
    return { success: false, error: `Fetch failed: ${fetchError?.message}` };
  }

  const deliberation = row as DeliberationRow;

  // 2. Determine next round
  const nextRound = (deliberation.current_round + 1) as RoundNumber;

  if (nextRound > 6) {
    // Already completed
    await supabase
      .from("deliberations")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", deliberationId);
    return { success: true };
  }

  const handler = ROUND_HANDLERS[nextRound];
  if (!handler) {
    return { success: false, error: `No handler for round ${nextRound}` };
  }

  // 3. Update status to in-progress
  const roundStatus: DeliberationStatus = STATUS_FOR_ROUND[nextRound];
  await supabase
    .from("deliberations")
    .update({ status: roundStatus, current_round: nextRound })
    .eq("id", deliberationId);

  // 4. Run the round
  const costTracker = new CostTracker(nextRound);

  try {
    const roundResult = await handler(deliberation, costTracker);

    // 5. Merge results into the graph
    const updatedGraph = mergeRoundResult(deliberation.graph, roundResult);

    // 6. Merge cost
    const updatedCost = costTracker.mergeInto(deliberation.cost);

    // 7. Persist
    const updatePayload: Record<string, unknown> = {
      graph: updatedGraph,
      cost: updatedCost,
      models_used: [
        ...new Set([
          ...deliberation.models_used,
          ...costTracker
            .buildRoundCost()
            .model_calls.map((c) => c.model),
        ]),
      ],
    };

    // If this was round 6, mark completed
    if (nextRound === 6) {
      updatePayload.status = "completed";
      updatePayload.completed_at = new Date().toISOString();
    }

    await supabase
      .from("deliberations")
      .update(updatePayload)
      .eq("id", deliberationId);

    console.log(
      `Round ${nextRound} complete for ${deliberationId}. ` +
        `Cost: $${costTracker.buildRoundCost().estimated_cost_usd.toFixed(4)}`
    );

    // 8. Trigger next round (fire-and-forget)
    if (nextRound < 6) {
      triggerNextRound(deliberationId);
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Round ${nextRound} failed for ${deliberationId}: ${message}`);

    // Persist failure state (allow retry)
    await supabase
      .from("deliberations")
      .update({
        status: "failed",
        error_message: message,
        retry_count: deliberation.retry_count + 1,
      })
      .eq("id", deliberationId);

    return { success: false, error: message };
  }
}

/**
 * Merge a round's partial graph result into the full deliberation graph.
 */
function mergeRoundResult(
  graph: DeliberationGraph,
  partial: Partial<DeliberationGraph>
): DeliberationGraph {
  return {
    rounds: partial.rounds
      ? [...graph.rounds, ...partial.rounds]
      : graph.rounds,
    convergence_map: partial.convergence_map ?? graph.convergence_map,
    residue: partial.residue ?? graph.residue,
    neologisms: partial.neologisms
      ? [...graph.neologisms, ...partial.neologisms]
      : graph.neologisms,
    quality_flags: partial.quality_flags
      ? [...graph.quality_flags, ...partial.quality_flags]
      : graph.quality_flags,
  };
}

/**
 * Fire-and-forget invocation of the next round via edge function self-call.
 * Adds a small delay to avoid overwhelming the system.
 */
function triggerNextRound(deliberationId: string): void {
  const functionsUrl = Deno.env.get("SUPABASE_FUNCTIONS_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!functionsUrl || !serviceKey) {
    console.error("Cannot trigger next round: missing SUPABASE_FUNCTIONS_URL or key");
    return;
  }

  // Fire-and-forget with 2s delay to let DB settle
  setTimeout(() => {
    fetch(`${functionsUrl}/run-round`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ deliberation_id: deliberationId }),
    }).catch((err) =>
      console.error(`Failed to trigger next round: ${err.message}`)
    );
  }, 2000);
}
