// Edge Function: Get Council Reading
// Returns the witness council reading and metadata for a deliberation.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Missing required parameter: id" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const supabase = getSupabaseClient();

    // Fetch deliberation
    const { data: deliberation, error: dError } = await supabase
      .from("deliberations")
      .select(
        "id, topic, status, entry_type, formed_question, council_reading, architecture_version, partial_council, created_at, completed_at, cost"
      )
      .eq("id", id)
      .single();

    if (dError || !deliberation) {
      return new Response(
        JSON.stringify({ error: "Deliberation not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fetch testimonies
    const { data: testimonies } = await supabase
      .from("testimonies")
      .select(
        "witness_id, witness_name, model, testimony_text, token_count, thinking_enabled, thinking_token_count, created_at"
      )
      .eq("deliberation_id", id)
      .order("created_at");

    return new Response(
      JSON.stringify({
        id: deliberation.id,
        status: deliberation.status,
        entry_text: deliberation.topic,
        entry_type: deliberation.entry_type,
        formed_question: deliberation.formed_question,
        council_reading: deliberation.council_reading,
        architecture_version: deliberation.architecture_version,
        partial_council: deliberation.partial_council,
        testimonies: testimonies ?? [],
        cost: deliberation.cost,
        created_at: deliberation.created_at,
        completed_at: deliberation.completed_at,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`get-reading error: ${message}`);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
