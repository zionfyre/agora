// Edge Function: Corpus Analysis Dashboard API
// Read-only queries against the deliberations table for dashboard consumption.
// Returns aggregate stats, per-deliberation metrics, neologism catalog, etc.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { detectAnomalies } from "../_shared/anomaly-rules.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "summary";

  try {
    const supabase = getSupabase();
    let result: unknown;

    switch (view) {
      case "summary":
        result = await getSummary(supabase);
        break;
      case "deliberations":
        result = await getDeliberations(supabase);
        break;
      case "neologisms":
        result = await getNeologisms(supabase);
        break;
      case "opacity":
        result = await getOpacityEvents(supabase);
        break;
      case "tensions":
        result = await getTensions(supabase);
        break;
      case "compare":
        result = await getComparison(supabase);
        break;
      case "partner-status":
        result = await getPartnerStatus(supabase);
        break;
      case "flagged":
        result = await getFlagged(supabase);
        break;
      case "tier-comparison":
        result = await getTierComparison(supabase);
        break;
      case "anomalies":
        result = await getAnomalies(supabase);
        break;
      case "queue":
        result = await getQueueHealth(supabase);
        break;
      default:
        return new Response(
          JSON.stringify({ error: `Unknown view: ${view}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    return new Response(JSON.stringify(result, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ── Summary view ────────────────────────────────────────────────

async function getSummary(supabase: ReturnType<typeof createClient>) {
  const { data: rows } = await supabase
    .from("deliberations")
    .select("id, status, topic, topic_category, cost, graph, entropy_scores, partner_status, voices_used, created_at, completed_at");

  if (!rows || !rows.length) return { total: 0 };

  const completed = rows.filter((r: any) => r.status === "completed");
  const failed = rows.filter((r: any) => r.status === "failed");
  const inProgress = rows.filter(
    (r: any) => r.status !== "completed" && r.status !== "failed" && r.status !== "pending"
  );

  // Aggregate costs
  const totalCost = completed.reduce(
    (sum: number, r: any) => sum + (r.cost?.estimated_cost_usd ?? 0),
    0
  );

  // Entropy stats
  const allEntropy: number[] = [];
  for (const r of completed) {
    const graph = r.graph;
    if (graph?.rounds) {
      for (const round of graph.rounds) {
        if (round.entropy_score != null) {
          allEntropy.push(round.entropy_score);
        }
      }
    }
  }

  // Steelman stats
  let steelmanTotal = 0;
  let steelmanPassing = 0;
  let steelmanSum = 0;
  const opacityEvents: any[] = [];

  for (const r of completed) {
    const steelmanRound = r.graph?.rounds?.find((rd: any) => rd.round_type === "steelman");
    if (steelmanRound) {
      for (const node of steelmanRound.nodes) {
        if (node.steelman_score != null) {
          steelmanTotal++;
          steelmanSum += node.steelman_score;
          if (node.steelman_score >= 3) steelmanPassing++;
          if (node.steelman_score <= 2) {
            opacityEvents.push({
              deliberation: r.topic,
              by: node.voice,
              target: node.target_voice,
              score: node.steelman_score,
            });
          }
        }
      }
    }
  }

  // Neologism stats
  let neologismCount = 0;
  let unanimousCount = 0;
  for (const r of completed) {
    const neos = r.graph?.neologisms ?? [];
    neologismCount += neos.length;
    for (const neo of neos) {
      const votes = Object.values(neo.vote_distribution ?? {});
      if (votes.length > 0 && votes.every((v: any) => v === "yes")) {
        unanimousCount++;
      }
    }
  }

  // Tension stats
  let tensionCount = 0;
  for (const r of completed) {
    tensionCount += r.graph?.residue?.irreconcilable_tensions?.length ?? 0;
  }

  // Category distribution
  const categories: Record<string, number> = {};
  for (const r of rows) {
    categories[r.topic_category] = (categories[r.topic_category] ?? 0) + 1;
  }

  // Partner status breakdown
  const partnerBreakdown: Record<string, number> = {};
  for (const r of rows) {
    const ps = r.partner_status ?? "NONE";
    partnerBreakdown[ps] = (partnerBreakdown[ps] ?? 0) + 1;
  }

  // Voice council size breakdown
  const fourVoice = completed.filter(
    (r: any) => !(r.voices_used ?? []).includes("relational_ontologist")
  );
  const fiveVoice = completed.filter(
    (r: any) => (r.voices_used ?? []).includes("relational_ontologist")
  );

  return {
    total_deliberations: rows.length,
    completed: completed.length,
    failed: failed.length,
    in_progress: inProgress.length,
    partner_status: partnerBreakdown,
    council_size: {
      four_voice: fourVoice.length,
      five_voice: fiveVoice.length,
    },
    total_cost_usd: parseFloat(totalCost.toFixed(4)),
    avg_cost_per_deliberation: completed.length
      ? parseFloat((totalCost / completed.length).toFixed(4))
      : 0,
    entropy: {
      count: allEntropy.length,
      mean: allEntropy.length
        ? parseFloat(
            (allEntropy.reduce((a, b) => a + b, 0) / allEntropy.length).toFixed(3)
          )
        : null,
      min: allEntropy.length ? parseFloat(Math.min(...allEntropy).toFixed(3)) : null,
      max: allEntropy.length ? parseFloat(Math.max(...allEntropy).toFixed(3)) : null,
    },
    steelman: {
      total_scored: steelmanTotal,
      passing: steelmanPassing,
      pass_rate: steelmanTotal
        ? parseFloat(((steelmanPassing / steelmanTotal) * 100).toFixed(1))
        : null,
      mean_score: steelmanTotal
        ? parseFloat((steelmanSum / steelmanTotal).toFixed(2))
        : null,
    },
    opacity_events: opacityEvents.length,
    neologisms: {
      total: neologismCount,
      unanimous: unanimousCount,
    },
    tensions: tensionCount,
    categories,
  };
}

// ── Deliberations list ──────────────────────────────────────────

async function getDeliberations(supabase: ReturnType<typeof createClient>) {
  const { data: rows } = await supabase
    .from("deliberations")
    .select(
      "id, topic, topic_category, status, current_round, cost, entropy_scores, partner_status, voices_used, created_at, completed_at"
    )
    .order("created_at", { ascending: true });

  return (rows ?? []).map((r: any) => ({
    id: r.id,
    topic: r.topic,
    category: r.topic_category,
    status: r.status,
    round: r.current_round,
    cost_usd: r.cost?.estimated_cost_usd ?? 0,
    partner_status: r.partner_status ?? "NONE",
    voices: r.voices_used?.length ?? 0,
    created_at: r.created_at,
    completed_at: r.completed_at,
  }));
}

// ── Neologism catalog ───────────────────────────────────────────

async function getNeologisms(supabase: ReturnType<typeof createClient>) {
  const { data: rows } = await supabase
    .from("deliberations")
    .select("id, topic, graph")
    .eq("status", "completed");

  const catalog: any[] = [];
  for (const r of rows ?? []) {
    for (const neo of r.graph?.neologisms ?? []) {
      const votes = neo.vote_distribution ?? {};
      const voteValues = Object.values(votes) as string[];
      catalog.push({
        term: neo.term,
        definition: neo.definition,
        proposing_voice: neo.proposing_voice,
        deliberation_topic: r.topic,
        deliberation_id: r.id,
        votes: votes,
        unanimous: voteValues.length > 0 && voteValues.every((v) => v === "yes"),
        yes_count: voteValues.filter((v) => v === "yes").length,
        total_votes: voteValues.length,
      });
    }
  }

  // Sort: unanimous first, then by yes count
  catalog.sort((a, b) => {
    if (a.unanimous !== b.unanimous) return a.unanimous ? -1 : 1;
    return b.yes_count - a.yes_count;
  });

  return { total: catalog.length, neologisms: catalog };
}

// ── Epistemic opacity events ────────────────────────────────────

async function getOpacityEvents(supabase: ReturnType<typeof createClient>) {
  const { data: rows } = await supabase
    .from("deliberations")
    .select("id, topic, graph")
    .eq("status", "completed");

  const events: any[] = [];
  const pairScores: Record<string, number[]> = {};

  for (const r of rows ?? []) {
    const steelmanRound = r.graph?.rounds?.find(
      (rd: any) => rd.round_type === "steelman"
    );
    if (!steelmanRound) continue;

    for (const node of steelmanRound.nodes) {
      if (node.steelman_score != null && node.steelman_score <= 2) {
        events.push({
          deliberation_topic: r.topic,
          deliberation_id: r.id,
          by: node.voice,
          target: node.target_voice,
          score: node.steelman_score,
        });
      }

      // Track all pair scores for hardest-pair analysis
      if (node.steelman_score != null && node.target_voice) {
        const pair = [node.voice, node.target_voice].sort().join("↔");
        if (!pairScores[pair]) pairScores[pair] = [];
        pairScores[pair].push(node.steelman_score);
      }
    }
  }

  // Compute pair averages
  const pairStats = Object.entries(pairScores)
    .map(([pair, scores]) => ({
      pair,
      mean: parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)),
      count: scores.length,
      opacity_count: scores.filter((s) => s <= 2).length,
    }))
    .sort((a, b) => a.mean - b.mean);

  return {
    total_events: events.length,
    events,
    pair_difficulty: pairStats,
  };
}

// ── Tension catalog ─────────────────────────────────────────────

async function getTensions(supabase: ReturnType<typeof createClient>) {
  const { data: rows } = await supabase
    .from("deliberations")
    .select("id, topic, graph")
    .eq("status", "completed");

  const tensions: any[] = [];
  for (const r of rows ?? []) {
    for (const t of r.graph?.residue?.irreconcilable_tensions ?? []) {
      tensions.push({
        deliberation_topic: r.topic,
        deliberation_id: r.id,
        description: t.description,
        voice_a: t.voice_a,
        voice_b: t.voice_b,
        irreconcilability_reason: t.irreconcilability_reason,
      });
    }
  }

  return { total: tensions.length, tensions };
}

// ── 4-voice vs 5-voice comparison ───────────────────────────────

async function getComparison(supabase: ReturnType<typeof createClient>) {
  const { data: rows } = await supabase
    .from("deliberations")
    .select("id, topic, topic_category, graph, cost, voices_used, partner_status")
    .eq("status", "completed");

  if (!rows?.length) return { error: "No completed deliberations" };

  const fourVoice = rows.filter(
    (r: any) => !(r.voices_used ?? []).includes("relational_ontologist")
  );
  const fiveVoice = rows.filter(
    (r: any) => (r.voices_used ?? []).includes("relational_ontologist")
  );

  function computeStats(group: any[]) {
    if (!group.length) return null;

    // Entropy
    const entropies: number[] = [];
    for (const r of group) {
      for (const round of r.graph?.rounds ?? []) {
        if (round.entropy_score != null) entropies.push(round.entropy_score);
      }
    }

    // Steelman
    let scored = 0, passing = 0, sum = 0, opacityCount = 0;
    const pairScores: Record<string, number[]> = {};
    for (const r of group) {
      const sr = r.graph?.rounds?.find((rd: any) => rd.round_type === "steelman");
      if (!sr) continue;
      for (const node of sr.nodes) {
        if (node.steelman_score != null) {
          scored++;
          sum += node.steelman_score;
          if (node.steelman_score >= 3) passing++;
          if (node.steelman_score <= 2) opacityCount++;
          if (node.target_voice) {
            const pair = [node.voice, node.target_voice].sort().join("↔");
            if (!pairScores[pair]) pairScores[pair] = [];
            pairScores[pair].push(node.steelman_score);
          }
        }
      }
    }

    // Neologisms
    let neoTotal = 0, neoUnanimous = 0;
    for (const r of group) {
      const neos = r.graph?.neologisms ?? [];
      neoTotal += neos.length;
      for (const neo of neos) {
        const votes = Object.values(neo.vote_distribution ?? {}) as string[];
        if (votes.length > 0 && votes.every((v) => v === "yes")) neoUnanimous++;
      }
    }

    // Tensions
    let tensionCount = 0;
    for (const r of group) {
      tensionCount += r.graph?.residue?.irreconcilable_tensions?.length ?? 0;
    }

    // Cost
    const totalCost = group.reduce(
      (s: number, r: any) => s + (r.cost?.estimated_cost_usd ?? 0), 0
    );

    // Pair difficulty
    const pairs = Object.entries(pairScores)
      .map(([pair, scores]) => ({
        pair,
        mean: parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)),
        count: scores.length,
        opacity_count: scores.filter((s) => s <= 2).length,
      }))
      .sort((a, b) => a.mean - b.mean);

    return {
      deliberations: group.length,
      entropy: {
        mean: entropies.length
          ? parseFloat((entropies.reduce((a, b) => a + b, 0) / entropies.length).toFixed(3))
          : null,
        min: entropies.length ? parseFloat(Math.min(...entropies).toFixed(3)) : null,
        max: entropies.length ? parseFloat(Math.max(...entropies).toFixed(3)) : null,
      },
      steelman: {
        scored,
        passing,
        pass_rate: scored ? parseFloat(((passing / scored) * 100).toFixed(1)) : null,
        mean_score: scored ? parseFloat((sum / scored).toFixed(2)) : null,
      },
      opacity: {
        total_events: opacityCount,
        rate_per_deliberation: parseFloat((opacityCount / group.length).toFixed(2)),
      },
      neologisms: {
        total: neoTotal,
        unanimous: neoUnanimous,
        per_deliberation: parseFloat((neoTotal / group.length).toFixed(1)),
        unanimous_per_deliberation: parseFloat((neoUnanimous / group.length).toFixed(1)),
      },
      tensions: {
        total: tensionCount,
        per_deliberation: parseFloat((tensionCount / group.length).toFixed(1)),
      },
      cost: {
        total: parseFloat(totalCost.toFixed(2)),
        per_deliberation: parseFloat((totalCost / group.length).toFixed(4)),
      },
      pair_difficulty: pairs.slice(0, 10),
    };
  }

  return {
    four_voice: computeStats(fourVoice),
    five_voice: computeStats(fiveVoice),
  };
}

// ── Partner status view ─────────────────────────────────────────

async function getPartnerStatus(supabase: ReturnType<typeof createClient>) {
  const { data: rows } = await supabase
    .from("deliberations")
    .select("partner_status, voice_tier, status");

  if (!rows?.length) return { total: 0 };

  const byPartner: Record<string, number> = {};
  const byTier: Record<string, Record<string, number>> = {};

  for (const r of rows as any[]) {
    const ps = r.partner_status ?? "NONE";
    const vt = r.voice_tier ?? "tier_1";
    byPartner[ps] = (byPartner[ps] ?? 0) + 1;
    if (!byTier[vt]) byTier[vt] = {};
    byTier[vt][ps] = (byTier[vt][ps] ?? 0) + 1;
  }

  return {
    total: rows.length,
    by_partner_status: byPartner,
    by_voice_tier: byTier,
  };
}

// ── Flagged deliberations view ──────────────────────────────────

async function getFlagged(supabase: ReturnType<typeof createClient>) {
  const { data: rows } = await supabase
    .from("deliberations")
    .select("id, topic, topic_category, voice_tier, partner_status, corpus_note, created_at, completed_at")
    .eq("requires_partner_review", true)
    .order("created_at", { ascending: true });

  return {
    total_flagged: (rows ?? []).length,
    flagged: (rows ?? []).map((r: any) => ({
      id: r.id,
      topic: r.topic,
      category: r.topic_category,
      voice_tier: r.voice_tier,
      partner_status: r.partner_status,
      flag_reason: r.corpus_note,
      created_at: r.created_at,
      completed_at: r.completed_at,
    })),
  };
}

// ── Tier comparison view (live endpoint for research summary) ───

async function getTierComparison(supabase: ReturnType<typeof createClient>) {
  // Reuse the compare logic but add tier metadata
  const comparison = await getComparison(supabase);
  return {
    ...comparison,
    metadata: {
      description: "Side-by-side metrics for 4-voice vs 5-voice deliberations",
      four_voice_note: "Tier 1 baseline: Falsificationist, Formal Reasoner, Trickster, Aesthetic Reasoner",
      five_voice_note: "Tier 1 + Relational Ontologist (PENDING_PARTNER, Kimi K2.5 proxy)",
      generated_at: new Date().toISOString(),
    },
  };
}

// ── Anomalies view (dynamic rule-based detection) ────────────────

async function getAnomalies(supabase: ReturnType<typeof createClient>) {
  const { data: rows } = await supabase
    .from("deliberations")
    .select("id, topic, topic_category, voice_tier, voices_used, graph, created_at, completed_at")
    .eq("status", "completed")
    .order("created_at", { ascending: true });

  const anomalies: any[] = [];
  const countByType: Record<string, number> = {};

  for (const r of rows ?? []) {
    const flags = detectAnomalies({
      graph: r.graph,
      voices_used: r.voices_used ?? [],
    });

    for (const flag of flags) {
      countByType[flag.anomaly_type] = (countByType[flag.anomaly_type] ?? 0) + 1;
      anomalies.push({
        deliberation_id: r.id,
        topic: r.topic,
        category: r.topic_category,
        voice_tier: r.voice_tier,
        voices: r.voices_used?.length ?? 0,
        anomaly_type: flag.anomaly_type,
        flag_reason: flag.flag_reason,
        created_at: r.created_at,
        completed_at: r.completed_at,
      });
    }
  }

  return {
    total_deliberations: (rows ?? []).length,
    total_anomalies: anomalies.length,
    flagged_deliberations: new Set(anomalies.map((a) => a.deliberation_id)).size,
    by_type: countByType,
    anomalies,
  };
}

// ── Queue health view ─────────────────────────────────────────────

async function getQueueHealth(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase.rpc("get_queue_health");

  if (error) {
    throw new Error(`get_queue_health RPC failed: ${error.message}`);
  }

  return data;
}
