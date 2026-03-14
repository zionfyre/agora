// Edge Function: Run the next round for a deliberation
// Generic handler — reads state, runs the appropriate round, triggers next

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { advanceDeliberation } from "../_shared/state-machine.ts";

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
    const { deliberation_id } = await req.json();

    if (!deliberation_id) {
      return new Response(
        JSON.stringify({ error: "Missing deliberation_id" }),
        { status: 400 }
      );
    }

    console.log(`run-round invoked for deliberation ${deliberation_id}`);

    const result = await advanceDeliberation(deliberation_id);

    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`run-round error: ${message}`);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
