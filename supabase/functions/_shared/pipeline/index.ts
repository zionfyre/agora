// Witness Council Pipeline Orchestrator
// Entry → Classify → Form Question → Parallel Witness Dispatch → Council Reading

import { getSupabaseClient } from "../supabase.ts";
import { generateQueryEmbedding } from "../corpus-retrieval.ts";
import { classifyEntry } from "./classifier.ts";
import { formQuestion } from "./question-former.ts";
import { dispatchWitnesses } from "./witness-dispatch.ts";
import { generateCouncilReading } from "./council-reading.ts";

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

      await supabase
        .from("deliberations")
        .update({
          council_reading: reading.reading,
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", deliberationId);

      console.log(`[${deliberationId.slice(0, 8)}] Council reading complete`);
    } else {
      // Reading already exists — just mark completed
      await supabase
        .from("deliberations")
        .update({
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
