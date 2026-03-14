// Round 4 — Cartographer Pass
// A dedicated model (not one of the 8 voices) reads the full transcript
// and classifies every significant disagreement.
// Uses Opus tier — classification quality is critical.

import { completeJSON } from "../openrouter.ts";
import { MODEL_VERSIONS } from "../models.ts";
import { CostTracker } from "../cost-tracker.ts";
import type {
  DeliberationRow,
  DeliberationGraph,
  Round,
  CartographerOutput,
  QualityFlag,
} from "../types.ts";

const CARTOGRAPHER_SYSTEM = `You are the Cartographer. You do not deliberate. You map.

Your task: read the deliberation transcript and produce a
structured classification of every significant disagreement.

For each disagreement you identify:
  1. Name the two (or more) positions in conflict
  2. Identify the voices holding each position
  3. Classify the disagreement type:
     - empirical: resolved by better data; both sides agree on evidence standards
     - conceptual: resolved by clearer definitions or logical clarification
     - normative: about values or priorities; facts agreed, weighting differs
     - epistemic: about what counts as valid evidence or reasoning
     - ontological: about what exists or what is real; no shared reality
     - incommensurable: compound; disagreement about evidence prevents
       identifying what evidence would resolve it
  4. If empirical: state what data would resolve it
  5. If conceptual: state what definition would resolve it
  6. If incommensurable: state precisely why resolution is impossible
     without epistemic loss, and what that loss would be

You also identify:
  - convergence_signatures: unexpected alignments across
    epistemologically distant voices
  - stealth_consensus: positions that appear to conflict but
    are actually compatible at a higher level of abstraction
  - framework_limits: things no voice in this deliberation
    can see because of shared blind spots

Output: structured JSON conforming to the CartographerOutput schema.
Do not produce prose. Do not offer opinions. Map only.

CartographerOutput schema:
{
  "disagreements": [{
    "id": "uuid",
    "positions": [{ "voice": "voice_name", "position": "summary" }],
    "type": "empirical|conceptual|normative|epistemic|ontological|incommensurable",
    "resolution_path": "string or null",
    "irreconcilability_reason": "string or null",
    "epistemic_loss": "string or null"
  }],
  "convergence_signatures": [{
    "id": "uuid",
    "voices": ["voice1", "voice2"],
    "routes": ["how voice1 arrived", "how voice2 arrived"],
    "shared_conclusion": "what they agree on",
    "significance": "why this matters"
  }],
  "stealth_consensus": [{
    "description": "what appears to conflict but doesn't",
    "voices": ["voice1", "voice2"]
  }],
  "framework_limits": [{
    "description": "what no voice can see"
  }]
}`;

export async function runCartographer(
  deliberation: DeliberationRow,
  costTracker: CostTracker
): Promise<Partial<DeliberationGraph>> {
  // Build the full transcript from rounds 1-3
  const transcript = buildTranscript(deliberation.graph);

  const model = MODEL_VERSIONS.opus;

  const { data, cost } = await completeJSON<CartographerOutput>(
    model,
    CARTOGRAPHER_SYSTEM,
    `DELIBERATION TRANSCRIPT:\n\nTopic: ${deliberation.topic}\n\n${transcript}`,
    "cartographer",
    { max_tokens: 8192 }
  );

  costTracker.addCall(cost);

  // Quality checks
  const qualityFlags: QualityFlag[] = [];

  // Check: if >80% empirical, epistemic tilt may be insufficient
  const totalDisagreements = data.disagreements.length;
  if (totalDisagreements > 0) {
    const empiricalCount = data.disagreements.filter(
      (d) => d.type === "empirical"
    ).length;
    const empiricalRate = empiricalCount / totalDisagreements;

    if (empiricalRate > 0.8) {
      qualityFlags.push({
        type: "low_epistemic_tilt",
        severity: "warning",
        message: `${(empiricalRate * 100).toFixed(0)}% of disagreements classified as empirical — epistemic tilt may be insufficient`,
        round: 4,
      });
    }

    // Check incommensurability rate (target: 20-40%)
    const incommCount = data.disagreements.filter(
      (d) => d.type === "epistemic" || d.type === "incommensurable"
    ).length;
    const incommRate = incommCount / totalDisagreements;

    if (incommRate < 0.2) {
      qualityFlags.push({
        type: "low_incommensurability",
        severity: "info",
        message: `Incommensurability rate ${(incommRate * 100).toFixed(0)}% — below 20% target`,
        round: 4,
      });
    } else if (incommRate > 0.6) {
      qualityFlags.push({
        type: "high_incommensurability",
        severity: "info",
        message: `Incommensurability rate ${(incommRate * 100).toFixed(0)}% — above 60%, topic may be too abstract`,
        round: 4,
      });
    }
  }

  // Build residue catalog from incommensurable disagreements
  const irreconcilableTensions = data.disagreements
    .filter((d) => d.type === "incommensurable" || d.type === "ontological")
    .map((d) => ({
      tension_id: d.id,
      description: d.irreconcilability_reason ?? "Classified as irreconcilable",
      voice_a: d.positions[0]?.voice ?? "unknown",
      voice_b: d.positions[1]?.voice ?? "unknown",
      voice_a_position: d.positions[0]?.position ?? "",
      voice_b_position: d.positions[1]?.position ?? "",
      irreconcilability_reason: d.irreconcilability_reason ?? "",
      what_would_resolve_it: d.epistemic_loss
        ? `Resolution requires accepting epistemic loss: ${d.epistemic_loss}`
        : "Unknown",
      neologism_ids: [] as string[],
    }));

  const round: Round = {
    round_number: 4,
    round_type: "cartographer",
    nodes: [], // Cartographer produces structured output, not nodes
    epistemic_moves: [],
    entropy_score: null,
  };

  return {
    rounds: [round],
    residue: {
      irreconcilable_tensions: irreconcilableTensions,
      open_questions: [],
      framework_limits: data.framework_limits.map((fl) => ({
        voice: "cartographer" as any,
        limit_description: fl.description,
      })),
    },
    convergence_map: data.convergence_signatures,
    quality_flags: qualityFlags,
  };
}

function buildTranscript(graph: DeliberationGraph): string {
  let transcript = "";

  for (const round of graph.rounds) {
    transcript += `\n${"=".repeat(60)}\nROUND ${round.round_number} — ${round.round_type.toUpperCase()}\n${"=".repeat(60)}\n\n`;

    for (const node of round.nodes) {
      transcript += `[${node.voice.toUpperCase()}]`;
      if (node.target_voice) {
        transcript += ` → [${node.target_voice.toUpperCase()}]`;
      }
      if (node.steelman_score) {
        transcript += ` (steelman score: ${node.steelman_score}/5)`;
      }
      transcript += `\n${node.content}\n\n---\n\n`;
    }
  }

  return transcript;
}
