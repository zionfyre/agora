// Edge Function: Cancel an in-progress deliberation
// Sets status to 'cancelled'. The round-worker will skip queued rounds
// for cancelled deliberations.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, PATCH",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (req.method !== "POST" && req.method !== "PATCH") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const deliberationId = body.deliberation_id;

    if (!deliberationId || typeof deliberationId !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing required field: deliberation_id" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const supabase = getSupabaseClient();

    // Read current deliberation state
    const { data: row, error: fetchError } = await supabase
      .from("deliberations")
      .select("id, status")
      .eq("id", deliberationId)
      .single();

    if (fetchError || !row) {
      return new Response(
        JSON.stringify({ error: "deliberation_not_found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Already completed or failed — cannot cancel
    if (row.status === "completed" || row.status === "failed") {
      return new Response(
        JSON.stringify({ error: "deliberation_already_finished" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // Already cancelled — idempotent success
    if (row.status === "cancelled") {
      return new Response(
        JSON.stringify({ id: deliberationId, status: "already_cancelled" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Cancel the deliberation
    const { error: updateError } = await supabase
      .from("deliberations")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", deliberationId);

    if (updateError) {
      throw new Error(`Failed to cancel deliberation: ${updateError.message}`);
    }

    console.log(`Deliberation ${deliberationId} cancelled`);

    return new Response(
      JSON.stringify({ id: deliberationId, status: "cancelled" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`cancel-deliberation error: ${message}`);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
