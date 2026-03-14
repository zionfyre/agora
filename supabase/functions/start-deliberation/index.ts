// Edge Function: Start a new deliberation
// Creates the deliberation record and triggers Round 1

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { ACTIVE_VOICES } from "../_shared/voices.ts";
import { advanceDeliberation } from "../_shared/state-machine.ts";
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

    // Validate required fields
    if (!body.statement || !body.category) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: statement, category",
        }),
        { status: 400 }
      );
    }

    const supabase = getSupabaseClient();

    // Initialize empty graph
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

    // Create deliberation record
    const { data, error } = await supabase
      .from("deliberations")
      .insert({
        topic: body.statement,
        topic_category: body.category,
        topic_context: body.context ?? null,
        tension_axes: body.tension_axes ?? [],
        status: "pending",
        current_round: 0,
        graph: emptyGraph,
        cost: emptyCost,
        voices_used: ACTIVE_VOICES.map((v) => v.name),
        models_used: [],
      })
      .select("id")
      .single();

    if (error) {
      throw new Error(`Failed to create deliberation: ${error.message}`);
    }

    const deliberationId = data.id;
    console.log(`Created deliberation ${deliberationId}: "${body.statement}"`);

    // Trigger Round 1 (fire-and-forget — don't block the response)
    const functionsUrl = Deno.env.get("SUPABASE_FUNCTIONS_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (functionsUrl && serviceKey) {
      // Don't await — let the response return immediately
      fetch(`${functionsUrl}/run-round`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ deliberation_id: deliberationId }),
      }).catch((err) =>
        console.error(`Failed to trigger Round 1: ${err.message}`)
      );
    } else {
      // Local dev: run inline
      advanceDeliberation(deliberationId);
    }

    return new Response(
      JSON.stringify({
        id: deliberationId,
        status: "pending",
        message: "Deliberation created. Round 1 triggered.",
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
