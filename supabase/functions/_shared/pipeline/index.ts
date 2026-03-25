// Witness Council Pipeline Orchestrator
// Entry → Classify → Form Question → Parallel Witness Dispatch → Council Reading

import { getSupabaseClient } from "../supabase.ts";
import { generateQueryEmbedding } from "../corpus-retrieval.ts";
import { classifyEntry } from "./classifier.ts";
import { formQuestion } from "./question-former.ts";
import { dispatchWitnesses } from "./witness-dispatch.ts";
import { generateCouncilReading } from "./council-reading.ts";
import type { CostRecord, ModelCallCost } from "../types.ts";

// Accumulates costs across the witness pipeline stages
class WitnessCostTracker {
  private calls: ModelCallCost[] = [];

  add(cost: { model?: string; voice?: string; prompt_tokens: number; completion_tokens: number; estimated_cost_usd: number }) {
    this.calls.push({
      model: cost.model ?? "unknown",
      voice: (cost.voice ?? "pipeline") as ModelCallCost["voice"],
      prompt_tokens: cost.prompt_tokens,
      completion_tokens: cost.completion_tokens,
      estimated_cost_usd: cost.estimated_cost_usd,
    });
  }

  addAll(costs: { model: string; voice: string; prompt_tokens: number; completion_tokens: number; estimated_cost_usd: number }[]) {
    for (const c of costs) this.add(c);
  }

  build(): CostRecord {
    const totalPrompt = this.calls.reduce((s, c) => s + c.prompt_tokens, 0);
    const totalCompletion = this.calls.reduce((s, c) => s + c.completion_tokens, 0);
    const totalCost = this.calls.reduce((s, c) => s + c.estimated_cost_usd, 0);
    return {
      total_tokens: totalPrompt + totalCompletion,
      prompt_tokens: totalPrompt,
      completion_tokens: totalCompletion,
      estimated_cost_usd: totalCost,
      per_round: [{
        round: 1 as const,
        tokens: totalPrompt + totalCompletion,
        prompt_tokens: totalPrompt,
        completion_tokens: totalCompletion,
        estimated_cost_usd: totalCost,
        model_calls: this.calls,
      }],
    };
  }
}

export async function runWitnessPipeline(
  deliberationId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();

  // 1. Read deliberation row
  const { data: row, error: fetchError } = await supabase
    .from("deliberations")
    .select("*")
    .eq("id", deliberationId)
    .single();

  if (fetchError || !row) {
    return { success: false, error: `Fetch failed: ${fetchError?.message}` };
  }

  // Check for cancellation
  if (row.status === "cancelled") {
    console.log(`Deliberation ${deliberationId} cancelled — skipping`);
    return { success: true };
  }

  const entryText = row.topic;
  const costs = new WitnessCostTracker();

  try {
    // ── Stage 1: Classify ────────────────────────────────────────
    // Idempotency: skip if entry_type already set
    let entryType = row.entry_type;
    if (!entryType) {
      await supabase
        .from("deliberations")
        .update({ status: "pending" }) // classifying
        .eq("id", deliberationId);

      console.log(`[${deliberationId.slice(0, 8)}] Stage 1: Classifying entry`);
      const classification = await classifyEntry(entryText);
      entryType = classification.result.entry_type;
      costs.add({ model: "anthropic/claude-sonnet-4.5", voice: "pipeline", ...classification.cost });

      await supabase
        .from("deliberations")
        .update({ entry_type: entryType })
        .eq("id", deliberationId);

      console.log(
        `[${deliberationId.slice(0, 8)}] Classified as: ${entryType} (${classification.result.confidence})`
      );
    }

    // ── Stage 2: Form Question ───────────────────────────────────
    // Idempotency: skip if formed_question already set
    let formedQuestion = row.formed_question;
    if (!formedQuestion) {
      console.log(`[${deliberationId.slice(0, 8)}] Stage 2: Forming question`);
      const qf = await formQuestion(entryText, entryType);
      formedQuestion = qf.question;
      costs.add({ model: "anthropic/claude-sonnet-4.5", voice: "pipeline", ...qf.cost });

      await supabase
        .from("deliberations")
        .update({ formed_question: formedQuestion })
        .eq("id", deliberationId);

      console.log(
        `[${deliberationId.slice(0, 8)}] Question formed${qf.passedVerbatim ? " (verbatim)" : ""}`
      );
    }

    // ── Stage 3: Witness Dispatch ────────────────────────────────
    // Idempotency: skip if testimonies already exist
    const { count: existingTestimonies } = await supabase
      .from("testimonies")
      .select("id", { count: "exact", head: true })
      .eq("deliberation_id", deliberationId);

    let partial = row.partial_council ?? false;

    if (!existingTestimonies || existingTestimonies === 0) {
      console.log(`[${deliberationId.slice(0, 8)}] Stage 3: Dispatching witnesses`);

      await supabase
        .from("deliberations")
        .update({ status: "round_1_formation" }) // reuse existing status for frontend compat
        .eq("id", deliberationId);

      const dispatch = await dispatchWitnesses(
        deliberationId,
        entryText,
        formedQuestion
      );

      partial = dispatch.partial;
      costs.addAll(dispatch.costs);

      if (partial) {
        await supabase
          .from("deliberations")
          .update({ partial_council: true })
          .eq("id", deliberationId);
      }

      // Update models_used and voices_used
      const modelsUsed = [...new Set(dispatch.costs.map((c) => c.model))];
      const voicesUsed = dispatch.testimonies.map((t) => t.witness_id);
      await supabase
        .from("deliberations")
        .update({ models_used: modelsUsed, voices_used: voicesUsed })
        .eq("id", deliberationId);

      console.log(
        `[${deliberationId.slice(0, 8)}] ${dispatch.testimonies.length} testimonies recorded${partial ? " (partial)" : ""}`
      );
    }

    // ── Stage 4: Council Reading ─────────────────────────────────
    // Idempotency: skip if council_reading already set
    if (!row.council_reading) {
      console.log(`[${deliberationId.slice(0, 8)}] Stage 4: Generating council reading`);

      // Fetch all testimonies for this deliberation
      const { data: testimonies, error: tError } = await supabase
        .from("testimonies")
        .select("*")
        .eq("deliberation_id", deliberationId);

      if (tError || !testimonies || testimonies.length === 0) {
        throw new Error(
          `No testimonies found for reading: ${tError?.message ?? "empty"}`
        );
      }

      const reading = await generateCouncilReading(
        entryText,
        formedQuestion,
        testimonies
      );
      costs.add({ model: "anthropic/claude-sonnet-4.5", voice: "pipeline", ...reading.cost });

      // Persist cost + reading + completion atomically
      const finalCost = costs.build();
      await supabase
        .from("deliberations")
        .update({
          council_reading: reading.reading,
          cost: finalCost,
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", deliberationId);

      console.log(
        `[${deliberationId.slice(0, 8)}] Council reading complete — $${finalCost.estimated_cost_usd.toFixed(4)} (${finalCost.total_tokens} tokens)`
      );
    } else {
      // Reading already exists — persist accumulated cost and mark completed
      const finalCost = costs.build();
      await supabase
        .from("deliberations")
        .update({
          cost: finalCost,
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", deliberationId);
    }

    // ── Post-completion: topic embedding (fire-and-forget) ───────
    generateQueryEmbedding(entryText)
      .then((embedding) =>
        supabase
          .from("deliberations")
          .update({ topic_embedding: embedding })
          .eq("id", deliberationId)
      )
      .catch((err) =>
        console.error(`Topic embedding failed for ${deliberationId}:`, err)
      );

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[${deliberationId.slice(0, 8)}] Pipeline failed: ${message}`
    );

    await supabase
      .from("deliberations")
      .update({
        status: "failed",
        error_message: message,
      })
      .eq("id", deliberationId);

    return { success: false, error: message };
  }
}
