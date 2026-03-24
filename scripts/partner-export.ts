#!/usr/bin/env -S npx tsx
// The Agora Project — Epistemic Partner Outreach Export
// Generates a human-readable JSON export for potential epistemic partners.
// Usage: npx tsx scripts/partner-export.ts

import * as fs from "fs";
import * as path from "path";

// ── Load env ──────────────────────────────────────────────────

const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${key}` };

async function fetchView(view: string) {
  const res = await fetch(`${url}/functions/v1/corpus-stats?view=${view}`, { headers });
  if (!res.ok) throw new Error(`${view}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("Fetching corpus data...");

  const [summary, opacity, tensions, comparison, anomalies, neologisms] =
    await Promise.all([
      fetchView("summary"),
      fetchView("opacity"),
      fetchView("tensions"),
      fetchView("tier-comparison"),
      fetchView("anomalies"),
      fetchView("neologisms"),
    ]);

  // ── 1. Relational Ontologist gap frequency ──────────────

  const gapAnomalies = (anomalies.anomalies ?? []).filter(
    (a: any) => a.anomaly_type === "cartographer_gap_absence"
  );
  const gapCount = gapAnomalies.length;
  const fiveVoiceCount = comparison.five_voice?.deliberations ?? 0;
  const gapAbsenceRate = fiveVoiceCount > 0
    ? ((gapCount / fiveVoiceCount) * 100).toFixed(1)
    : "N/A";

  // Representative gap descriptions from tensions involving RO
  const roTensions = (tensions.tensions ?? []).filter(
    (t: any) =>
      t.voice_a === "relational_ontologist" || t.voice_b === "relational_ontologist"
  );
  const gapQuotes = roTensions.slice(0, 3).map((t: any) => ({
    topic: t.deliberation_topic,
    description: t.description,
    irreconcilability: t.irreconcilability_reason,
    voices: `${t.voice_a} ↔ ${t.voice_b}`,
  }));

  // ── 2. Empiricist-relational steelman failure data ──────

  const pairDifficulty = opacity.pair_difficulty ?? [];

  const falsRoPair = pairDifficulty.find(
    (p: any) => p.pair === "falsificationist↔relational_ontologist"
  );
  const formalRoPair = pairDifficulty.find(
    (p: any) => p.pair === "formal_reasoner↔relational_ontologist"
  );

  // Find opacity events (score ≤ 2) for these pairs
  const roOpacityEvents = (opacity.events ?? []).filter(
    (e: any) =>
      (e.by === "falsificationist" && e.target === "relational_ontologist") ||
      (e.by === "formal_reasoner" && e.target === "relational_ontologist") ||
      (e.by === "relational_ontologist" && e.target === "falsificationist") ||
      (e.by === "relational_ontologist" && e.target === "formal_reasoner")
  );

  const failureExamples = roOpacityEvents.slice(0, 3).map((e: any) => ({
    topic: e.deliberation_topic,
    steelman_by: e.by,
    target: e.target,
    score: e.score,
    note: `${e.by} scored ${e.score}/5 attempting to steelman ${e.target}'s position`,
  }));

  // ── 3. The 4.57 anomaly — AR↔RO pair data ─────────────

  const arRoPair = pairDifficulty.find(
    (p: any) => p.pair === "aesthetic_reasoner↔relational_ontologist"
  );

  const arRoAnomalies = (anomalies.anomalies ?? []).filter(
    (a: any) => a.anomaly_type === "high_legibility_ar_ro"
  );

  const highScoringExamples = arRoAnomalies.slice(0, 3).map((a: any) => ({
    topic: a.topic,
    flag_reason: a.flag_reason,
    note: "Aesthetic Reasoner and Relational Ontologist appear to comprehend each other with near-zero friction — is this genuine or aesthetic-adjacent collapse?",
  }));

  // ── 4. Neologisms from RO-gap-pronounced topics ────────

  // Find topics that appear in both gap anomalies and neologism catalog
  const gapTopics = new Set(gapAnomalies.map((a: any) => a.topic));
  const gapNeologisms = (neologisms.neologisms ?? []).filter(
    (n: any) => gapTopics.has(n.deliberation_topic)
  );
  // Prefer unanimous neologisms
  const sampleNeologisms = gapNeologisms
    .sort((a: any, b: any) => (b.unanimous ? 1 : 0) - (a.unanimous ? 1 : 0))
    .slice(0, 3)
    .map((n: any) => ({
      term: n.term,
      definition: n.definition,
      proposing_voice: n.proposing_voice,
      topic: n.deliberation_topic,
      unanimous: n.unanimous,
      note: "This term emerged from a deliberation where the Cartographer flagged the absence of the relational ontological perspective — the neologism names the space the missing voice would occupy.",
    }));

  // ── Assemble export ────────────────────────────────────

  const exportData = {
    title: "The Agora Project — Epistemic Partner Data Export",
    generated_at: new Date().toISOString(),
    purpose:
      "This document contains measured findings from the Agora deliberation corpus that demonstrate why epistemic partnership with scholars from relational knowledge traditions is necessary for the project's integrity.",

    corpus_summary: {
      total_deliberations: summary.total_deliberations,
      completed: summary.completed,
      four_voice_deliberations: comparison.four_voice?.deliberations ?? 0,
      five_voice_deliberations: comparison.five_voice?.deliberations ?? 0,
      total_cost_usd: summary.total_cost_usd,
      total_neologisms: summary.neologisms?.total ?? 0,
      total_opacity_events: summary.opacity_events,
    },

    three_questions_for_the_epistemic_partner: {
      preamble:
        "These are not rhetorical questions. The answers directly determine whether the Agora Project's most significant finding represents corpus integrity (genuine comprehension) or corpus contamination (aesthetic-adjacent collapse). A potential partner who can answer these questions from inside the tradition they represent is the most valuable collaborator the project can find.",

      question_1: {
        text: `The Falsificationist cannot steelman relational ontology — it scores ${falsRoPair?.mean ?? "N/A"} with ${falsRoPair?.opacity_count ?? "N/A"} opacity events across ${fiveVoiceCount} deliberations. When you read these steelman attempts, do they represent genuine incomprehension of your tradition, or do they represent a failure of our prompt to correctly represent what your tradition actually holds?`,
        data: {
          pair: "Falsificationist ↔ Relational Ontologist",
          mean_score: falsRoPair?.mean ?? null,
          opacity_events: falsRoPair?.opacity_count ?? null,
          sample_count: falsRoPair?.count ?? null,
        },
        example_failures: failureExamples.filter(
          (e) => e.steelman_by === "falsificationist" || e.target === "falsificationist"
        ),
      },

      question_2: {
        text: `The Formal Reasoner also scores ${formalRoPair?.mean ?? "N/A"} against the Relational Ontologist. Two independent empiricist voices hitting the same boundary is structural confirmation. Does this boundary feel accurate to you — does formal axiomatic reasoning genuinely struggle to inhabit relational epistemology in the way the data suggests?`,
        data: {
          pair: "Formal Reasoner ↔ Relational Ontologist",
          mean_score: formalRoPair?.mean ?? null,
          opacity_events: formalRoPair?.opacity_count ?? null,
          sample_count: formalRoPair?.count ?? null,
        },
        example_failures: failureExamples.filter(
          (e) => e.steelman_by === "formal_reasoner" || e.target === "formal_reasoner"
        ),
      },

      question_3: {
        text: `The Aesthetic Reasoner steelmans the Relational Ontologist at ${arRoPair?.mean ?? "N/A"} with ${arRoPair?.opacity_count ?? 0} opacity events. This is the finding that most needs your judgment: does this feel like genuine mutual comprehension between sensory truth and relational truth, or does it feel like the system is seeing itself reflected back — mistaking aesthetic knowing for relational knowing? Your answer tells us whether what the system currently treats as success is actually a misrecognition.`,
        data: {
          pair: "Aesthetic Reasoner ↔ Relational Ontologist",
          mean_score: arRoPair?.mean ?? null,
          opacity_events: arRoPair?.opacity_count ?? null,
          sample_count: arRoPair?.count ?? null,
          flagged_deliberations: arRoAnomalies.length,
        },
        example_high_scores: highScoringExamples,
      },
    },

    section_1_relational_ontologist_gap: {
      description:
        "How often the Cartographer round explicitly flags the absence or suppression of the relational ontological perspective in five-voice deliberations.",
      five_voice_deliberations: fiveVoiceCount,
      gap_absence_flags: gapCount,
      gap_absence_rate: `${gapAbsenceRate}%`,
      interpretation:
        "A high gap-absence rate means the Cartographer is not detecting the known epistemic boundary — the very boundary that makes the Relational Ontologist voice necessary.",
      representative_gap_descriptions: gapQuotes,
    },

    section_2_empiricist_relational_failure: {
      description:
        "Steelman failure data for the two empiricist voices attempting to inhabit relational epistemology. Scores of 1-2 are epistemic opacity events — the steelmanning voice genuinely cannot inhabit the target's ontological framework.",
      falsificationist_ro: {
        pair: "Falsificationist ↔ Relational Ontologist",
        mean_score: falsRoPair?.mean ?? null,
        total_scored: falsRoPair?.count ?? null,
        opacity_events: falsRoPair?.opacity_count ?? null,
      },
      formal_reasoner_ro: {
        pair: "Formal Reasoner ↔ Relational Ontologist",
        mean_score: formalRoPair?.mean ?? null,
        total_scored: formalRoPair?.count ?? null,
        opacity_events: formalRoPair?.opacity_count ?? null,
      },
      failure_examples: failureExamples,
    },

    section_3_aesthetic_relational_anomaly: {
      description:
        "The 4.57 anomaly: the Aesthetic Reasoner appears to comprehend the Relational Ontologist with near-zero friction. This is either genuine cross-framework comprehension or aesthetic-adjacent collapse — the system mistaking poetic resonance for relational knowing. Only someone inside the relational tradition can tell us which.",
      aesthetic_ro: {
        pair: "Aesthetic Reasoner ↔ Relational Ontologist",
        mean_score: arRoPair?.mean ?? null,
        total_scored: arRoPair?.count ?? null,
        opacity_events: arRoPair?.opacity_count ?? null,
        flagged_as_anomaly: arRoAnomalies.length,
      },
      high_scoring_examples: highScoringExamples,
    },

    section_4_neologisms_from_the_gap: {
      description:
        "Terms the deliberation system proposed to name the epistemic space that the Relational Ontologist voice is meant to fill. These neologisms emerged from topics where the Cartographer flagged the gap — the system is trying to name what it cannot reach.",
      sample_neologisms: sampleNeologisms,
    },

    closing:
      "The data shows that the Agora deliberation system has identified a real epistemic boundary — the empiricist voices genuinely cannot inhabit relational ontology. But the system cannot tell us whether its own comprehension of that boundary is accurate. That judgment requires a person standing inside the tradition the system is trying to represent. This is why the partnership matters: not as validation, but as accountability.",
  };

  // ── Write output ───────────────────────────────────────

  const date = new Date().toISOString().split("T")[0];
  const filename = `partner-export-${date}.json`;
  const outPath = path.resolve(__dirname, "..", filename);
  fs.writeFileSync(outPath, JSON.stringify(exportData, null, 2));

  console.log(`\nExport written to ${filename}`);
  console.log(`  Corpus: ${exportData.corpus_summary.total_deliberations} deliberations`);
  console.log(`  Gap absence flags: ${gapCount}`);
  console.log(`  Opacity events (empiricist↔RO): ${roOpacityEvents.length}`);
  console.log(`  AR↔RO anomaly flags: ${arRoAnomalies.length}`);
  console.log(`  Neologisms from gap topics: ${sampleNeologisms.length}`);
  console.log(`\nThree partner questions included.`);
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
