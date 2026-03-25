// Edge Function: Start a new deliberation
// witness-v1: classify → form question → parallel witness → council reading
// deliberation-v1: 6-round pipeline (legacy, preserved for backward compat)

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { ACTIVE_VOICES } from "../_shared/voices.ts";
import type { Topic, DeliberationGraph, CostRecord } from "../_shared/types.ts";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
    });
  }

  try {
    const body: Topic = await req.json();

    if (!body.statement) {
      return new Response(
        JSON.stringify({ error: "Missing required field: statement" }),
        { status: 400 }
      );
    }

    const supabase = getSupabaseClient();

    // Empty structures for schema compat with deliberation-v1 columns
    const emptyGraph: DeliberationGraph = {
      rounds: [],
      convergence_map: [],
      residue: {
        irreconcilable_tensions: [],
        open_questions: [],
        framework_limits: [],
      },
      neologisms: [],
      quality_flags: [],
    };

    const emptyCost: CostRecord = {
      total_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      estimated_cost_usd: 0,
      per_round: [],
    };

    // Create deliberation record — witness-v1 architecture
    const { data, error } = await supabase
      .from("deliberations")
      .insert({
        topic: body.statement,
        topic_category: body.category ?? "epistemic",
        topic_context: body.context ?? null,
        tension_axes: body.tension_axes ?? [],
        status: "pending",
        current_round: 0,
        graph: emptyGraph,
        cost: emptyCost,
        voices_used: ACTIVE_VOICES.map((v) => v.name),
        models_used: [],
        architecture_version: "witness-v1",
      })
      .select("id")
      .single();

    if (error) {
      throw new Error(`Failed to create deliberation: ${error.message}`);
    }

    const deliberationId = data.id;
    console.log(
      `Created witness-v1 deliberation ${deliberationId}: "${body.statement.slice(0, 80)}"`
    );

    // Enqueue for the round-worker (reuses existing queue + cron infrastructure)
    const { error: enqueueError } = await supabase.rpc("queue_send", {
      p_queue_name: "deliberation_rounds",
      p_msg: {
        deliberation_id: deliberationId,
        architecture: "witness-v1",
      },
    });

    if (enqueueError) {
      console.error(`Failed to enqueue: ${enqueueError.message}`);
      // Don't fail the request — the orphan sweep will catch it
    } else {
      console.log(`Enqueued witness pipeline for ${deliberationId}`);
    }

    return new Response(
      JSON.stringify({
        id: deliberationId,
        status: "pending",
        message: "Witness council dispatched.",
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`start-deliberation error: ${message}`);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
