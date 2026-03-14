#!/usr/bin/env -S deno run --allow-env --allow-net --allow-write

// The Agora Project — Local Test Runner
// Runs a single deliberation through all 6 rounds WITHOUT Supabase.
// State is maintained in memory. Output is logged + saved to JSON.
//
// Usage:
//   export OPENROUTER_API_KEY=your-key
//   deno run --allow-env --allow-net --allow-write scripts/test-deliberation.ts
//
// Options:
//   --topic <index>    Topic index from seed.json (default: 0 = "What does the forest know?")
//   --rounds <n>       Stop after round N (default: 6 = full run)
//   --dry-run          Print prompts without making API calls

import { CostTracker } from "../supabase/functions/_shared/cost-tracker.ts";
import { computeEntropy } from "../supabase/functions/_shared/entropy.ts";
import { ACTIVE_VOICES } from "../supabase/functions/_shared/voices.ts";
import { runFormation } from "../supabase/functions/_shared/rounds/formation.ts";
import { runSteelman } from "../supabase/functions/_shared/rounds/steelman.ts";
import { runCritique } from "../supabase/functions/_shared/rounds/critique.ts";
import { runCartographer } from "../supabase/functions/_shared/rounds/cartographer.ts";
import { runNeologism } from "../supabase/functions/_shared/rounds/neologism.ts";
import { runConvergence } from "../supabase/functions/_shared/rounds/convergence.ts";
import type {
  DeliberationRow,
  DeliberationGraph,
  CostRecord,
  RoundNumber,
  Topic,
} from "../supabase/functions/_shared/types.ts";

// ── Parse CLI args ─────────────────────────────────────────────

const args = parseArgs(Deno.args);
const topicIndex = parseInt(args["topic"] ?? "0");
const maxRounds = parseInt(args["rounds"] ?? "6") as RoundNumber;
const dryRun = args["dry-run"] !== undefined;

// ── Load topic ─────────────────────────────────────────────────

const seedData = JSON.parse(
  await Deno.readTextFile(new URL("../topics/seed.json", import.meta.url))
);
const allTopics: Topic[] = [
  ...seedData.tiers.tier_1_maximum_collision,
  ...seedData.tiers.tier_2_high_collision,
  ...seedData.tiers.tier_3_calibration,
];

if (topicIndex >= allTopics.length) {
  console.error(`Topic index ${topicIndex} out of range (0-${allTopics.length - 1})`);
  Deno.exit(1);
}

const topic = allTopics[topicIndex];
console.log(`\n${"═".repeat(70)}`);
console.log(`THE AGORA PROJECT — Test Deliberation`);
console.log(`${"═".repeat(70)}`);
console.log(`Topic: "${topic.statement}"`);
console.log(`Category: ${topic.category}`);
console.log(`Voices: ${ACTIVE_VOICES.map((v) => v.displayName).join(", ")}`);
console.log(`Rounds: 1–${maxRounds}`);
console.log(`Mode: ${dryRun ? "DRY RUN (no API calls)" : "LIVE"}`);
console.log(`${"═".repeat(70)}\n`);

if (dryRun) {
  console.log("Dry run mode — printing voice prompts and exiting.\n");
  for (const voice of ACTIVE_VOICES) {
    console.log(`--- ${voice.displayName} ---`);
    console.log(`Model tier: sonnet`);
    console.log(`Epistemic tilt: ${voice.epistemicTilt}`);
    console.log(`Prompt length: ${voice.systemPrompt.length} chars\n`);
  }
  Deno.exit(0);
}

// Verify API key
if (!Deno.env.get("OPENROUTER_API_KEY")) {
  console.error("ERROR: OPENROUTER_API_KEY not set");
  console.error("  export OPENROUTER_API_KEY=your-key-here");
  Deno.exit(1);
}

// ── Build in-memory deliberation state ─────────────────────────

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

let deliberation: DeliberationRow = {
  id: crypto.randomUUID(),
  topic: topic.statement,
  topic_category: topic.category,
  topic_context: topic.context,
  tension_axes: topic.tension_axes,
  status: "pending",
  current_round: 0,
  error_message: null,
  retry_count: 0,
  graph: emptyGraph,
  tension_score: null,
  entropy_scores: [],
  cost: emptyCost,
  human_reviewed: false,
  review_score: null,
  quality_flags: [],
  voices_used: ACTIVE_VOICES.map((v) => v.name),
  models_used: [],
  cartographer_model: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  completed_at: null,
};

// ── Round handlers ─────────────────────────────────────────────

const ROUND_HANDLERS = [
  { name: "Formation", handler: runFormation },
  { name: "Steelmanning", handler: runSteelman },
  { name: "Constrained Critique", handler: runCritique },
  { name: "Cartographer Pass", handler: runCartographer },
  { name: "Neologism Forging", handler: runNeologism },
  { name: "Convergence Mapping", handler: runConvergence },
];

// ── Run rounds ─────────────────────────────────────────────────

for (let round = 1; round <= maxRounds; round++) {
  const { name, handler } = ROUND_HANDLERS[round - 1];
  const costTracker = new CostTracker(round as RoundNumber);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`ROUND ${round} — ${name}`);
  console.log(`${"─".repeat(70)}\n`);

  const startTime = Date.now();

  try {
    const result = await handler(deliberation, costTracker);

    // Merge results into state
    if (result.rounds) {
      deliberation.graph.rounds.push(...result.rounds);

      // Log node content for formation round
      for (const r of result.rounds) {
        for (const node of r.nodes) {
          console.log(`[${node.voice.toUpperCase()}] (${node.node_type})`);
          // Truncate for readability
          const preview =
            node.content.length > 500
              ? node.content.slice(0, 500) + "..."
              : node.content;
          console.log(preview);
          if (node.steelman_score) {
            console.log(`  → Steelman score: ${node.steelman_score}/5`);
          }
          console.log();
        }

        if (r.entropy_score !== null) {
          console.log(`Entropy score: ${r.entropy_score}`);
        }
      }
    }

    if (result.convergence_map) {
      deliberation.graph.convergence_map = result.convergence_map;
      console.log(
        `Convergence signatures found: ${result.convergence_map.length}`
      );
    }

    if (result.residue) {
      deliberation.graph.residue = result.residue;
      console.log(
        `Irreconcilable tensions: ${result.residue.irreconcilable_tensions.length}`
      );
    }

    if (result.neologisms) {
      deliberation.graph.neologisms.push(...result.neologisms);
      console.log(`Neologisms forged: ${result.neologisms.length}`);
      for (const n of result.neologisms) {
        console.log(`  "${n.term}": ${n.definition}`);
      }
    }

    if (result.quality_flags) {
      deliberation.graph.quality_flags.push(...result.quality_flags);
      for (const flag of result.quality_flags) {
        console.log(`  [${flag.severity.toUpperCase()}] ${flag.message}`);
      }
    }

    // Update cost
    const roundCost = costTracker.buildRoundCost();
    deliberation.cost = costTracker.mergeInto(deliberation.cost);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `\nRound ${round} complete in ${elapsed}s — ` +
        `$${roundCost.estimated_cost_usd.toFixed(4)} ` +
        `(${roundCost.tokens} tokens)`
    );
  } catch (err) {
    console.error(`\nRound ${round} FAILED: ${err}`);
    deliberation.error_message = String(err);
    break;
  }

  deliberation.current_round = round;
}

// ── Summary ────────────────────────────────────────────────────

console.log(`\n${"═".repeat(70)}`);
console.log(`DELIBERATION COMPLETE`);
console.log(`${"═".repeat(70)}`);
console.log(`Topic: "${deliberation.topic}"`);
console.log(`Rounds completed: ${deliberation.current_round}`);
console.log(`Total cost: $${deliberation.cost.estimated_cost_usd.toFixed(4)}`);
console.log(`Total tokens: ${deliberation.cost.total_tokens}`);
console.log();

// Per-round cost breakdown
console.log("Cost breakdown:");
for (const rc of deliberation.cost.per_round) {
  console.log(
    `  Round ${rc.round}: $${rc.estimated_cost_usd.toFixed(4)} (${rc.tokens} tokens, ${rc.model_calls.length} API calls)`
  );
}

// Quality flags summary
if (deliberation.graph.quality_flags.length > 0) {
  console.log(`\nQuality flags (${deliberation.graph.quality_flags.length}):`);
  for (const flag of deliberation.graph.quality_flags) {
    console.log(`  [${flag.severity.toUpperCase()}] ${flag.message}`);
  }
}

// Neologisms summary
if (deliberation.graph.neologisms.length > 0) {
  console.log(`\nNeologisms forged (${deliberation.graph.neologisms.length}):`);
  for (const n of deliberation.graph.neologisms) {
    const votes = Object.entries(n.vote_distribution)
      .map(([v, vote]) => `${v}:${vote}`)
      .join(" ");
    console.log(`  "${n.term}" — ${n.definition}`);
    console.log(`    Votes: ${votes}`);
  }
}

// Save full output
const outputPath = `./deliberation-${deliberation.id.slice(0, 8)}.json`;
await Deno.writeTextFile(
  outputPath,
  JSON.stringify(deliberation, null, 2)
);
console.log(`\nFull output saved to: ${outputPath}`);

// ── Arg parser ─────────────────────────────────────────────────

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = "true";
      }
    }
  }
  return result;
}
