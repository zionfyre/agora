// Edge Function: Queue-based Round Worker
// Dequeues deliberation round messages from pgmq, executes via the
// atomic state machine, and enqueues the next round on success.
// Called by pg_cron every ~30 seconds via pg_net.
//
// Phase C: WORKER_CONCURRENCY controls parallel round processing.
// Messages are dequeued in a batch and processed via Promise.allSettled.
// Each round runs independently — failures don't block other rounds.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { advanceDeliberation } from "../_shared/state-machine.ts";

// Calibrated visibility timeouts by round (seconds).
// Must exceed worst-case execution time to prevent duplicate processing.
// Too short → duplicate execution when message reappears mid-run.
// Too long → slow retry on genuine failures.
const VISIBILITY_TIMEOUTS: Record<number, number> = {
  1: 180, // Formation: 5 parallel API calls, sonnet tier
  2: 300, // Steelmanning: highest volume round (20+ API calls)
  3: 180, // Critique: parallel, similar to round 1
  4: 240, // Cartographer: single Opus call, long structured output
  5: 280, // Neologism: parallel but slow — observed 173s, 60% buffer
  6: 240, // Convergence: single Opus call, long output
};

const DEFAULT_VT = 300; // Read with max VT, safe for all rounds

// WORKER_CONCURRENCY: how many rounds to process in parallel per invocation.
// Start at 5 (env-configurable). At 5 concurrent rounds every 30s = ~10 rounds/min.
// Back off by 1 if OpenRouter returns 429s. Ceiling is ~15 before rate limits.
const WORKER_CONCURRENCY = parseInt(
  Deno.env.get("WORKER_CONCURRENCY") ?? "5",
  10
);

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

  const body =
    req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const batchSize = body.batch_size ?? WORKER_CONCURRENCY;

  const supabase = getSupabaseClient();

  interface ProcessResult {
    deliberation_id: string;
    round: number;
    success: boolean;
    skipped?: boolean;
    error?: string;
  }

  try {
    // Dequeue batch from pgmq with max visibility timeout
    const { data: messages, error: readError } = await supabase.rpc(
      "queue_read",
      {
        p_queue_name: "deliberation_rounds",
        p_vt: DEFAULT_VT,
        p_qty: batchSize,
      }
    );

    if (readError) {
      throw new Error(`Queue read failed: ${readError.message}`);
    }

    if (!messages || messages.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0, message: "Queue empty" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log(
      `round-worker: dequeued ${messages.length} messages (concurrency=${batchSize})`
    );

    // Phase C: process all messages in parallel via Promise.allSettled.
    // Each round runs independently — a failure in one does not block others.
    // Failed messages stay in the queue and auto-retry after VT expires.
    const settlementResults = await Promise.allSettled(
      messages.map(
        async (msg: {
          msg_id: number;
          message: { deliberation_id: string; round_number: number };
        }): Promise<ProcessResult> => {
          const { deliberation_id, round_number } = msg.message;

          try {
            // Check if deliberation was cancelled before executing
            const { data: statusCheck } = await supabase
              .from("deliberations")
              .select("status")
              .eq("id", deliberation_id)
              .single();

            if (statusCheck?.status === "cancelled") {
              console.log(
                `Deliberation ${deliberation_id} cancelled — skipping round ${round_number}`
              );
              // Archive the message so it doesn't retry
              await supabase.rpc("queue_archive", {
                p_queue_name: "deliberation_rounds",
                p_msg_id: msg.msg_id,
              });
              return {
                deliberation_id,
                round: round_number,
                success: true,
                skipped: true,
              };
            }

            const result = await advanceDeliberation(deliberation_id, {
              triggerNext: false,
            });

            if (result.success) {
              // Archive the processed message (acknowledge)
              await supabase.rpc("queue_archive", {
                p_queue_name: "deliberation_rounds",
                p_msg_id: msg.msg_id,
              });

              // Enqueue next round if there is one
              if (result.nextRound) {
                await supabase.rpc("queue_send", {
                  p_queue_name: "deliberation_rounds",
                  p_msg: {
                    deliberation_id,
                    round_number: result.nextRound,
                  },
                });
                console.log(
                  `round-worker: enqueued round ${result.nextRound} for ${deliberation_id.slice(0, 8)}`
                );
              }

              return {
                deliberation_id,
                round: round_number,
                success: true,
                skipped: result.skipped,
              };
            } else {
              console.error(
                `round-worker: round ${round_number} failed for ${deliberation_id.slice(0, 8)}: ${result.error}`
              );
              return {
                deliberation_id,
                round: round_number,
                success: false,
                error: result.error,
              };
            }
          } catch (err) {
            const message =
              err instanceof Error ? err.message : String(err);
            console.error(
              `round-worker: unhandled error for ${deliberation_id.slice(0, 8)}: ${message}`
            );
            return {
              deliberation_id,
              round: round_number,
              success: false,
              error: message,
            };
            // Message auto-retries after VT expires
          }
        }
      )
    );

    // Collect results from settled promises
    const results: ProcessResult[] = settlementResults.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : {
            deliberation_id: "unknown",
            round: 0,
            success: false,
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason),
          }
    );

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return new Response(
      JSON.stringify({
        processed: results.length,
        succeeded,
        failed,
        concurrency: batchSize,
        results,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`round-worker error: ${message}`);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
