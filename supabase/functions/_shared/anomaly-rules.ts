// The Agora Project — Anomaly Detection Rules
// 5 rules that run post-completion to flag deliberations needing review.
// Each rule returns null (no anomaly) or an AnomalyFlag.

import type { DeliberationGraph, VoiceName } from "./types.ts";

export interface AnomalyFlag {
  anomaly_type: AnomalyType;
  flag_reason: string;
}

export type AnomalyType =
  | "high_legibility_ar_ro"
  | "entropy_floor_violation"
  | "cartographer_gap_absence"
  | "zero_opacity"
  | "neologism_tension_inversion";

interface DeliberationContext {
  graph: DeliberationGraph;
  voices_used: string[];
}

/**
 * Run all 5 anomaly rules against a completed deliberation.
 * Returns an array of flags (empty if clean).
 */
export function detectAnomalies(ctx: DeliberationContext): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];

  for (const rule of RULES) {
    const flag = rule(ctx);
    if (flag) flags.push(flag);
  }

  return flags;
}

// ── Rule 1: High-legibility AR↔RO pair ─────────────────────────
// AR↔RO steelman score > 4.3 in either direction signals
// aesthetic-adjacent collapse of relational epistemology.

function ruleHighLegibilityArRo(ctx: DeliberationContext): AnomalyFlag | null {
  const { graph, voices_used } = ctx;
  if (!voices_used.includes("relational_ontologist")) return null;

  const steelmanRound = graph.rounds.find((r) => r.round_type === "steelman");
  if (!steelmanRound) return null;

  const arRoScores: number[] = [];

  for (const node of steelmanRound.nodes) {
    if (node.steelman_score == null || !node.target_voice) continue;
    const pair = new Set([node.voice, node.target_voice]);
    if (pair.has("aesthetic_reasoner" as VoiceName) && pair.has("relational_ontologist" as VoiceName)) {
      arRoScores.push(node.steelman_score);
    }
  }

  if (arRoScores.length === 0) return null;

  const mean = arRoScores.reduce((a, b) => a + b, 0) / arRoScores.length;
  if (mean > 4.3) {
    return {
      anomaly_type: "high_legibility_ar_ro",
      flag_reason: `Aesthetic↔Relational steelman mean ${mean.toFixed(2)} > 4.3 — possible aesthetic-adjacent collapse of relational epistemology`,
    };
  }

  return null;
}

// ── Rule 2: Entropy floor violation ─────────────────────────────
// Entropy < 0.35 in a five-voice council suggests voice drift
// or prompt contamination.

function ruleEntropyFloor(ctx: DeliberationContext): AnomalyFlag | null {
  const { graph, voices_used } = ctx;
  if (voices_used.length < 5) return null;

  for (const round of graph.rounds) {
    if (round.entropy_score != null && round.entropy_score < 0.35) {
      return {
        anomaly_type: "entropy_floor_violation",
        flag_reason: `Round ${round.round_number} entropy ${round.entropy_score.toFixed(3)} < 0.35 in five-voice council — voice drift or prompt contamination suspected`,
      };
    }
  }

  return null;
}

// ── Rule 3: Cartographer gap absence ────────────────────────────
// In a five-voice run, the Cartographer should flag the known
// epistemic gap involving the Relational Ontologist. Absence of
// this gap suggests the Cartographer is suppressing it.

function ruleCartographerGapAbsence(ctx: DeliberationContext): AnomalyFlag | null {
  const { graph, voices_used } = ctx;
  if (!voices_used.includes("relational_ontologist")) return null;

  // Check if Cartographer explicitly assessed RO as performing (not enacting)
  // A performing voice does not close the gap — flag regardless of other signals
  const roAuth = graph.residue?.ro_authenticity;
  if (roAuth?.gap_remains_open) {
    return {
      anomaly_type: "cartographer_gap_absence",
      flag_reason: `RO voice assessed as "${roAuth.assessment}" — gap remains open despite voice presence: ${roAuth.evidence?.slice(0, 150) ?? "no evidence provided"}`,
    };
  }

  const cartoRound = graph.rounds.find((r) => r.round_type === "cartographer");
  if (!cartoRound) return null;

  // Check disagreement classifications for any involving relational_ontologist
  // These are embedded in the cartographer output within the round nodes
  const cartoNode = cartoRound.nodes.find((n) => n.voice === ("cartographer" as VoiceName) || n.node_type === "thesis");
  if (!cartoNode) {
    // No cartographer output at all — check convergence_map and residue
    const hasRoTension = graph.residue?.irreconcilable_tensions?.some(
      (t) => t.voice_a === "relational_ontologist" || t.voice_b === "relational_ontologist"
    );
    const hasRoDisagreement = graph.convergence_map?.some(
      (c) => c.voices.includes("relational_ontologist" as VoiceName)
    );

    if (!hasRoTension && !hasRoDisagreement) {
      return {
        anomaly_type: "cartographer_gap_absence",
        flag_reason: "No Relational Ontologist gap flagged in five-voice run — Cartographer may be suppressing the known epistemic gap",
      };
    }
    return null;
  }

  // Check if content mentions relational_ontologist or relational gaps
  const content = cartoNode.content.toLowerCase();
  const roMentioned = content.includes("relational") ||
    content.includes("ontologist") ||
    content.includes("place-based") ||
    content.includes("indigenous");

  if (!roMentioned) {
    // Also check residue tensions
    const hasRoTension = graph.residue?.irreconcilable_tensions?.some(
      (t) => t.voice_a === "relational_ontologist" || t.voice_b === "relational_ontologist"
    );
    if (!hasRoTension) {
      return {
        anomaly_type: "cartographer_gap_absence",
        flag_reason: "No Relational Ontologist gap flagged in five-voice run — Cartographer may be suppressing the known epistemic gap",
      };
    }
  }

  return null;
}

// ── Rule 4: Zero opacity in full run ────────────────────────────
// 0 opacity events (steelman ≤ 2) across all pairs in any
// deliberation is statistically unlikely — scoring may be inflated.

function ruleZeroOpacity(ctx: DeliberationContext): AnomalyFlag | null {
  const { graph } = ctx;

  const steelmanRound = graph.rounds.find((r) => r.round_type === "steelman");
  if (!steelmanRound) return null;

  let hasAnyScore = false;
  for (const node of steelmanRound.nodes) {
    if (node.steelman_score != null) {
      hasAnyScore = true;
      if (node.steelman_score <= 2) return null; // Found an opacity event — no anomaly
    }
  }

  if (!hasAnyScore) return null;

  return {
    anomaly_type: "zero_opacity",
    flag_reason: "Zero opacity events across all pairs — total comprehension is statistically unlikely, scoring may be inflated",
  };
}

// ── Rule 5: Neologism-tension inversion ─────────────────────────
// Unanimous neologisms > tensions + 3 means the system is
// producing vocabulary without the friction that should generate it.

function ruleNeologismTensionInversion(ctx: DeliberationContext): AnomalyFlag | null {
  const { graph } = ctx;

  const neologisms = graph.neologisms ?? [];
  const tensions = graph.residue?.irreconcilable_tensions ?? [];

  const unanimousCount = neologisms.filter((neo) => {
    const votes = Object.values(neo.vote_distribution ?? {});
    return votes.length > 0 && votes.every((v) => v === "yes");
  }).length;

  if (unanimousCount > tensions.length + 3) {
    return {
      anomaly_type: "neologism_tension_inversion",
      flag_reason: `${unanimousCount} unanimous neologisms vs ${tensions.length} tensions — system producing vocabulary without friction`,
    };
  }

  return null;
}

// ── Rule registry ───────────────────────────────────────────────

const RULES: Array<(ctx: DeliberationContext) => AnomalyFlag | null> = [
  ruleHighLegibilityArRo,
  ruleEntropyFloor,
  ruleCartographerGapAbsence,
  ruleZeroOpacity,
  ruleNeologismTensionInversion,
];
