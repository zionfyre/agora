#!/usr/bin/env -S npx tsx
// The Agora Project — Anomaly Digest
// Queries the anomalies endpoint and prints a summary.
// Usage: npx tsx scripts/anomaly-digest.ts [--save]

import * as fs from "fs";
import * as path from "path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Try loading from .env
  const envPath = path.resolve(__dirname, "../.env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match) process.env[match[1]] = match[2];
    }
  }
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const save = process.argv.includes("--save");

async function main() {
  const endpoint = `${url}/functions/v1/corpus-stats?view=anomalies`;
  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${key}` },
  });

  if (!res.ok) {
    console.error(`Anomalies endpoint returned ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const data = await res.json();

  // Print digest
  const now = new Date().toISOString().split("T")[0];
  console.log(`\n═══ Agora Anomaly Digest — ${now} ═══\n`);
  console.log(`Total completed deliberations: ${data.total_deliberations}`);
  console.log(`Flagged deliberations:         ${data.flagged_deliberations}`);
  console.log(`Total anomaly flags:           ${data.total_anomalies}`);
  console.log(
    `Flag rate:                     ${
      data.total_deliberations
        ? ((data.flagged_deliberations / data.total_deliberations) * 100).toFixed(1)
        : 0
    }%`
  );

  console.log(`\n── By Anomaly Type ──`);
  const types = data.by_type ?? {};
  if (Object.keys(types).length === 0) {
    console.log("  (none)");
  } else {
    for (const [type, count] of Object.entries(types)) {
      console.log(`  ${type}: ${count}`);
    }
  }

  // High-priority: new flags since last digest
  const highPriority = (data.anomalies ?? []).filter(
    (a: any) => a.anomaly_type === "high_legibility_ar_ro" || a.anomaly_type === "entropy_floor_violation"
  );
  if (highPriority.length > 0) {
    console.log(`\n── High-Priority Flags (${highPriority.length}) ──`);
    for (const a of highPriority) {
      console.log(`  [${a.anomaly_type}] ${a.topic.slice(0, 60)}...`);
      console.log(`    ${a.flag_reason}`);
    }
  }

  // Recent anomalies (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const recent = (data.anomalies ?? []).filter(
    (a: any) => a.created_at > weekAgo
  );
  if (recent.length > 0) {
    console.log(`\n── Recent (last 7 days): ${recent.length} flags ──`);
    for (const a of recent) {
      const date = a.created_at?.split("T")[0] ?? "unknown";
      console.log(`  ${date} [${a.anomaly_type}] ${a.topic.slice(0, 50)}`);
    }
  }

  console.log(`\n═══ End Digest ═══\n`);

  // Optionally save to file
  if (save) {
    const filename = `anomaly-digest-${now}.json`;
    const outPath = path.resolve(__dirname, "..", filename);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`Saved to ${filename}`);
  }
}

main().catch((err) => {
  console.error("Digest failed:", err);
  process.exit(1);
});
