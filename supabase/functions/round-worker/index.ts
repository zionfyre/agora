// Edge Function: Queue-based Worker
// Architecture-aware: dispatches witness-v1 or deliberation-v1 pipelines.
// Called by pg_cron every ~30 seconds via pg_net.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { advanceDeliberation } from "../_shared/state-machine.ts";
import { runWitnessPipeline } from "../_shared/pipeline/index.ts";

// Visibility timeout for witness-v1: full pipeline runs 2-5 minutes
const WITNESS_VT = 600;

// Legacy deliberation-v1 VT
const DEFAULT_VT = 300;

// Concurrency: witness-v1 pipelines are heavier, process one at a time
const WORKER_CONCURRENCY = parseInt(
  Deno.env.get("WORKER_CONCURRENCY") ?? "3",
  10
);

interface ProcessResult {
  deliberation_id: string;
  architecture: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
}

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

  try {
    // Dequeue batch with high VT to cover witness-v1 pipelines
    const { data: messages, error: readError } = await supabase.rpc(
      "queue_read",
      {
        p_queue_name: "deliberation_rounds",
        p_vt: WITNESS_VT,
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

    const settlementResults = await Promise.allSettled(
      messages.map(
        async (msg: {
          msg_id: number;
          message: {
            deliberation_id: string;
            architecture?: string;
            round_number?: number;
          };
        }): Promise<ProcessResult> => {
          const { deliberation_id, architecture, round_number } = msg.message;
          const arch = architecture ?? "deliberation-v1"; // backward compat

          try {
            if (arch === "witness-v1") {
              // ── Witness council pipeline ──
              console.log(
                `round-worker: running witness-v1 pipeline for ${deliberation_id.slice(0, 8)}`
              );
              const result = await runWitnessPipeline(deliberation_id);

              if (!result.success) {
                // On failure: message stays in queue, retries after VT expires
                return {
                  deliberation_id,
                  architecture: arch,
                  success: false,
                  error: result.error,
                };
              }

              // Archive LAST — after council_reading written and status is completed
              await supabase.rpc("queue_archive", {
                p_queue_name: "deliberation_rounds",
                p_msg_id: msg.msg_id,
              });

              return {
                deliberation_id,
                architecture: arch,
                success: true,
              };
            } else {
              // ── Legacy deliberation-v1 round pipeline ──
              // Check for cancellation
              const { data: statusCheck } = await supabase
                .from("deliberations")
                .select("status")
                .eq("id", deliberation_id)
                .single();

              if (statusCheck?.status === "cancelled") {
                console.log(
                  `Deliberation ${deliberation_id} cancelled — skipping`
                );
                await supabase.rpc("queue_archive", {
                  p_queue_name: "deliberation_rounds",
                  p_msg_id: msg.msg_id,
                });
                return {
                  deliberation_id,
                  architecture: arch,
                  success: true,
                  skipped: true,
                };
              }

              const result = await advanceDeliberation(deliberation_id, {
                triggerNext: false,
              });

              if (result.success) {
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
              }

              return {
                deliberation_id,
                architecture: arch,
                success: result.success,
                skipped: result.skipped,
                error: result.error,
              };
            }
          } catch (err) {
            const message =
              err instanceof Error ? err.message : String(err);
            console.error(
              `round-worker: error for ${deliberation_id.slice(0, 8)} (${arch}): ${message}`
            );
            return {
              deliberation_id,
              architecture: arch,
              success: false,
              error: message,
            };
          }
        }
      )
    );

    const results: ProcessResult[] = settlementResults.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : {
            deliberation_id: "unknown",
            architecture: "unknown",
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
