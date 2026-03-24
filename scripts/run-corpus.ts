#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env
/**
 * Automated corpus runner — fires deliberations 11-50 via the production pipeline.
 * Reads all 40 seed topics, fires each one, polls for completion,
 * then starts the next. Includes 10 repeat runs of tier 1 topics.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-env scripts/run-corpus.ts
 *   deno run --allow-net --allow-read --allow-env scripts/run-corpus.ts --start 11 --end 50
 *   deno run --allow-net --allow-read --allow-env scripts/run-corpus.ts --dry-run
 */

import "https://deno.land/std@0.208.0/dotenv/load.ts";

interface Topic {
  statement: string;
  category: string;
  context: string;
  tension_axes: string[];
}

interface SeedFile {
  tiers: {
    tier_1_maximum_collision: Topic[];
    tier_2_high_collision: Topic[];
    tier_3_calibration: Topic[];
  };
}

// ── Config ──────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

const POLL_INTERVAL_MS = 30_000; // Check every 30s
const MAX_WAIT_MS = 25 * 60_000; // 25 min timeout per deliberation (Opus rounds can be slow)
const DELAY_BETWEEN_MS = 5_000;  // 5s between deliberations

// ── Parse args ──────────────────────────────────────────────────

const args = parseArgs(Deno.args);

function parseArgs(rawArgs: string[]): {
  start: number;
  end: number;
  dryRun: boolean;
  concurrency: number;
  topicFile: string | null;
} {
  let start = 11;
  let end = 50;
  let dryRun = false;
  let concurrency = 1;
  let topicFile: string | null = null;

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--start") start = parseInt(rawArgs[++i]);
    if (rawArgs[i] === "--end") end = parseInt(rawArgs[++i]);
    if (rawArgs[i] === "--dry-run") dryRun = true;
    if (rawArgs[i] === "--concurrency") concurrency = parseInt(rawArgs[++i]);
    if (rawArgs[i] === "--topics") topicFile = rawArgs[++i];
  }

  return { start, end, dryRun, concurrency, topicFile };
}

// ── Build topic list ────────────────────────────────────────────

async function buildTopicList(): Promise<Topic[]> {
  // Custom topic file (flat array of topics)
  if (args.topicFile) {
    const raw = await Deno.readTextFile(args.topicFile);
    const data = JSON.parse(raw);
    // Support { topics: [...] } or plain array
    return data.topics ?? data;
  }

  const raw = await Deno.readTextFile("topics/seed.json");
  const seed: SeedFile = JSON.parse(raw);

  // Flatten all tiers: tier 1 (21) + tier 2 (20) + tier 3 (19) = 60
  const allTopics = [
    ...seed.tiers.tier_1_maximum_collision,
    ...seed.tiers.tier_2_high_collision,
    ...seed.tiers.tier_3_calibration,
  ];

  return allTopics;
}

// ── API calls ───────────────────────────────────────────────────

async function startDeliberation(topic: Topic): Promise<string> {
  const response = await fetch(`${FUNCTIONS_URL}/start-deliberation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(topic),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Start failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.id;
}

async function getStatus(
  id: string
): Promise<{ status: string; current_round: number; error_message: string | null; cost: { estimated_cost_usd: number } }> {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/deliberations?id=eq.${id}&select=status,current_round,error_message,cost`,
    {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    }
  );

  const rows = await response.json();
  return rows[0];
}

async function waitForCompletion(id: string, label: string): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT_MS) {
    const status = await getStatus(id);

    if (status.status === "completed") {
      console.log(
        `  ✓ ${label} completed (${status.current_round} rounds, $${status.cost.estimated_cost_usd.toFixed(4)})`
      );
      return true;
    }

    if (status.status === "failed") {
      console.error(`  ✗ ${label} FAILED: ${status.error_message}`);
      return false;
    }

    // Still running
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.log(
      `  … ${label} round ${status.current_round}/6 (${status.status}, ${elapsed}s)`
    );
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.error(`  ✗ ${label} TIMED OUT after ${MAX_WAIT_MS / 1000}s`);
  return false;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
    Deno.exit(1);
  }

  const allTopics = await buildTopicList();
  const slice = allTopics.slice(args.start - 1, args.end);

  console.log(`\n═══ Agora Corpus Runner ═══`);
  console.log(`Topics: ${args.start}–${args.end} (${slice.length} deliberations)`);
  console.log(`Concurrency: ${args.concurrency}`);
  console.log(`Endpoint: ${FUNCTIONS_URL}\n`);

  if (args.dryRun) {
    for (let i = 0; i < slice.length; i++) {
      const num = args.start + i;
      console.log(`[${num}] ${slice[i].statement} (${slice[i].category})`);
    }
    console.log(`\nDry run — ${slice.length} deliberations would be fired.`);
    return;
  }

  const results: { num: number; topic: string; id: string; success: boolean }[] = [];
  let completed = 0;
  let failed = 0;

  // Sequential execution (concurrency=1 by default for cost control)
  for (let i = 0; i < slice.length; i++) {
    const num = args.start + i;
    const topic = slice[i];
    const label = `[${num}/${args.end}] "${topic.statement}"`;

    console.log(`\n${label}`);
    console.log(`  Category: ${topic.category}`);

    try {
      const id = await startDeliberation(topic);
      console.log(`  Started: ${id}`);

      const success = await waitForCompletion(id, label);
      results.push({ num, topic: topic.statement, id, success });

      if (success) completed++;
      else failed++;
    } catch (err) {
      console.error(`  ✗ ${label} ERROR: ${err}`);
      results.push({ num, topic: topic.statement, id: "none", success: false });
      failed++;
    }

    // Brief pause between deliberations
    if (i < slice.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_MS));
    }
  }

  // ── Summary ─────────────────────────────────────────────────

  console.log(`\n═══ Corpus Run Complete ═══`);
  console.log(`Completed: ${completed}/${slice.length}`);
  console.log(`Failed: ${failed}/${slice.length}`);

  if (failed > 0) {
    console.log(`\nFailed deliberations:`);
    for (const r of results.filter((r) => !r.success)) {
      console.log(`  [${r.num}] ${r.topic} (${r.id})`);
    }
  }

  // Save results manifest
  const manifest = {
    run_date: new Date().toISOString(),
    range: `${args.start}-${args.end}`,
    total: slice.length,
    completed,
    failed,
    results,
  };

  const manifestPath = `corpus-run-${args.start}-${args.end}.json`;
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest saved: ${manifestPath}`);
}

main();
