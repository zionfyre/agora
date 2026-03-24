#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read

// Corpus Ingestion Pipeline
// Reads a JSON manifest, generates embeddings, and upserts into tradition_corpus.
// Idempotent: uses ON CONFLICT (tradition, source_text, chunk_index) DO UPDATE.
//
// Usage:
//   deno run --allow-env --allow-net --allow-read scripts/ingest-corpus.ts scripts/corpus-manifests/east-asian.json
//   deno run --allow-env --allow-net --allow-read scripts/ingest-corpus.ts scripts/corpus-manifests/east-asian.json --dry-run

import "https://deno.land/std@0.208.0/dotenv/load.ts";
import { generateEmbedding } from "./lib/generate-embedding.ts";

// ── Types ────────────────────────────────────────────────────────

interface ManifestChunk {
  source_text: string;     // Title of source work
  source_author: string;   // Author or attribution
  sub_tradition: string;   // e.g. 'confucian', 'nyaya'
  chunk_index: number;     // Ordering within source
  chunk_text: string;      // The actual passage
  metadata?: Record<string, unknown>;
  requires_partner_review?: boolean;
}

interface Manifest {
  tradition: string;       // e.g. 'east_asian'
  description: string;     // Human-readable description
  chunks: ManifestChunk[];
}

// ── Config ───────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────

const manifestPath = Deno.args[0];
const dryRun = Deno.args.includes("--dry-run");

if (!manifestPath) {
  console.error("Usage: ingest-corpus.ts <manifest.json> [--dry-run]");
  Deno.exit(1);
}

const manifestText = await Deno.readTextFile(manifestPath);
const manifest: Manifest = JSON.parse(manifestText);

console.log(`\nIngesting corpus: ${manifest.description}`);
console.log(`Tradition: ${manifest.tradition}`);
console.log(`Chunks: ${manifest.chunks.length}`);
console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

let ingested = 0;
let skipped = 0;
let errors = 0;

for (let i = 0; i < manifest.chunks.length; i++) {
  const chunk = manifest.chunks[i];
  const label = `[${i + 1}/${manifest.chunks.length}] ${chunk.source_text} #${chunk.chunk_index}`;

  try {
    // Generate embedding
    console.log(`${label} — embedding...`);
    const embedding = await generateEmbedding(chunk.chunk_text);

    if (dryRun) {
      console.log(`${label} — OK (dry run, ${embedding.length}d)`);
      ingested++;
      continue;
    }

    // Upsert into tradition_corpus
    // ON CONFLICT: update chunk_text and embedding (idempotent re-ingestion)
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/tradition_corpus?on_conflict=tradition,source_text,chunk_index`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_KEY!,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          tradition: manifest.tradition,
          sub_tradition: chunk.sub_tradition,
          source_text: chunk.source_text,
          source_author: chunk.source_author,
          chunk_index: chunk.chunk_index,
          chunk_text: chunk.chunk_text,
          embedding: JSON.stringify(embedding),
          metadata: chunk.metadata ?? {},
          requires_partner_review: chunk.requires_partner_review ?? false,
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "unknown");
      throw new Error(`Supabase upsert error ${res.status}: ${body}`);
    }

    console.log(`${label} — ingested`);
    ingested++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label} — ERROR: ${msg}`);
    errors++;
  }
}

console.log(`\n── Results ──`);
console.log(`Ingested: ${ingested}`);
console.log(`Errors:   ${errors}`);
if (dryRun) console.log(`(Dry run — no rows written)`);

// Verify row count
if (!dryRun) {
  const countRes = await fetch(
    `${SUPABASE_URL}/rest/v1/tradition_corpus?tradition=eq.${manifest.tradition}&select=id`,
    {
      headers: {
        apikey: SERVICE_KEY!,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Prefer: "count=exact",
      },
    }
  );
  const countHeader = countRes.headers.get("content-range");
  console.log(`Total rows for ${manifest.tradition}: ${countHeader}`);
}

if (errors > 0) Deno.exit(1);
