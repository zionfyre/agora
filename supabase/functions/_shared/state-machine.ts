// The Agora Project — Round-based State Machine
// Each round is a separate invocation. State persisted to DB between rounds.
// On completion of a round, triggers the next round via self-invocation
// OR returns nextRound for queue-based orchestration.

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
import { detectAnomalies } from "./anomaly-rules.ts";
import { generateQueryEmbedding } from "./corpus-retrieval.ts";

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
 * and persists results atomically (current_round only advances after success).
 *
 * @param options.triggerNext - If false, caller handles next-round triggering
 *   (used by queue worker). Defaults to true (legacy self-invocation).
 */
export async function advanceDeliberation(
  deliberationId: string,
  options?: { triggerNext?: boolean }
): Promise<{
  success: boolean;
  skipped?: boolean;
  nextRound?: number;
  error?: string;
}> {
  const supabase = getSupabaseClient();
  const shouldTriggerNext = options?.triggerNext ?? true;

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

  // 1b. Check for cancellation before running any round
  if (deliberation.status === "cancelled") {
    console.log(
      `Deliberation ${deliberationId} cancelled — skipping advancement`
    );
    return { success: true, skipped: true };
  }

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

  // 3. Idempotency check — if round data already exists, skip execution.
  // Handles: round ran + persisted successfully, but next-round trigger failed.
  // Without this, a retry re-runs the handler, wastes API calls, and
  // potentially overwrites good data with different results.
  const roundAlreadyComplete = deliberation.graph.rounds?.some(
    (r: Round) => r.round_number === nextRound
  );
  if (roundAlreadyComplete) {
    console.log(
      `Idempotency: round ${nextRound} already complete for ${deliberationId}, advancing`
    );
    // Advance current_round to match the graph state
    await supabase
      .from("deliberations")
      .update({ current_round: nextRound })
      .eq("id", deliberationId);

    if (nextRound < 6 && shouldTriggerNext) {
      triggerNextRound(deliberationId);
    }
    return {
      success: true,
      skipped: true,
      nextRound: nextRound < 6 ? nextRound + 1 : undefined,
    };
  }

  const handler = ROUND_HANDLERS[nextRound];
  if (!handler) {
    return { success: false, error: `No handler for round ${nextRound}` };
  }

  // 4. Run the round handler.
  // NO status/current_round write before execution — this is the atomic fix.
  // If the handler fails or times out, DB state is unchanged and the round
  // can be retried cleanly. This eliminates silent round-skipping.
  const costTracker = new CostTracker(nextRound);

  try {
    const roundResult = await handler(deliberation, costTracker);

    // 5. Merge results into the graph
    const updatedGraph = mergeRoundResult(deliberation.graph, roundResult);

    // 6. Merge cost
    const updatedCost = costTracker.mergeInto(deliberation.cost);

    // 7. Build atomic update payload.
    // current_round advances HERE — not before the handler runs.
    const roundStatus: DeliberationStatus = STATUS_FOR_ROUND[nextRound];
    const updatePayload: Record<string, unknown> = {
      current_round: nextRound,
      status: roundStatus,
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

    // Persist RAG augmentation flag from formation round
    if (nextRound === 1 && (roundResult as any)._ragAugmented) {
      updatePayload.rag_augmented = true;
    }

    // If this was round 6, mark completed and run anomaly detection
    if (nextRound === 6) {
      updatePayload.status = "completed";
      updatePayload.completed_at = new Date().toISOString();

      // Run anomaly detection on the final graph
      const anomalyFlags = detectAnomalies({
        graph: updatedGraph,
        voices_used: deliberation.voices_used,
      });

      // Check for scoring instability in quality_flags
      const scoringInstability = updatedGraph.quality_flags?.find(
        (f) => f.type === "scoring_instability"
      );
      if (scoringInstability) {
        anomalyFlags.push({
          anomaly_type: "scoring_instability" as any,
          flag_reason: scoringInstability.message,
        });
      }

      if (anomalyFlags.length > 0) {
        updatePayload.requires_partner_review = true;
        updatePayload.corpus_note = anomalyFlags
          .map((f) => `[${f.anomaly_type}] ${f.flag_reason}`)
          .join(" | ");
        console.log(
          `Anomalies detected for ${deliberationId}: ${anomalyFlags.length} flags`
        );
      }
    }

    // 8. ATOMIC WRITE — single UPDATE with optimistic locking.
    // WHERE current_round = <expected> ensures no other process has
    // advanced this deliberation since we read it. If another process
    // already advanced, the update affects 0 rows — no data corruption.
    const { data: updated, error: updateError } = await supabase
      .from("deliberations")
      .update(updatePayload)
      .eq("id", deliberationId)
      .eq("current_round", deliberation.current_round)
      .select("id");

    if (updateError) {
      throw new Error(`Atomic persistence failed: ${updateError.message}`);
    }

    if (!updated || updated.length === 0) {
      console.warn(
        `Optimistic lock: ${deliberationId} round ${nextRound} — another process advanced`
      );
      return { success: true, skipped: true };
    }

    console.log(
      `Round ${nextRound} complete for ${deliberationId}. ` +
        `Cost: $${costTracker.buildRoundCost().estimated_cost_usd.toFixed(4)}`
    );

    // 9a. Fire-and-forget topic embedding on completion
    if (nextRound === 6) {
      generateQueryEmbedding(deliberation.topic)
        .then((embedding) =>
          supabase
            .from("deliberations")
            .update({ topic_embedding: embedding })
            .eq("id", deliberationId)
        )
        .catch((err) =>
          console.error(`topic embedding failed for ${deliberationId}:`, err)
        );
    }

    // 9b. Trigger next round (unless caller handles it, e.g. queue worker)
    if (nextRound < 6 && shouldTriggerNext) {
      triggerNextRound(deliberationId);
    }

    return {
      success: true,
      nextRound: nextRound < 6 ? nextRound + 1 : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Round ${nextRound} failed for ${deliberationId}: ${message}`);

    // Persist failure state — current_round is NOT advanced
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
 * Legacy trigger — queue worker bypasses this via { triggerNext: false }.
 */
function triggerNextRound(deliberationId: string): void {
  const functionsUrl = Deno.env.get("EDGE_FUNCTIONS_URL") ??
    `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!functionsUrl || !serviceKey) {
    console.error("Cannot trigger next round: missing SUPABASE_FUNCTIONS_URL or key");
    return;
  }

  // Fire-and-forget — no setTimeout, edge functions kill process after response
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
}
