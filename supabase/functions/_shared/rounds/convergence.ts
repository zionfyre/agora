// Round 6 — Convergence Mapping
// The Cartographer performs a second pass to identify unexpected convergences:
// moments where epistemologically distant voices arrived at the same conclusion
// via entirely different routes.
// Uses Opus tier — meta-reasoning quality matters.

import { completeJSON } from "../openrouter.ts";
import { MODEL_VERSIONS } from "../models.ts";
import { CostTracker } from "../cost-tracker.ts";
import type {
  DeliberationRow,
  DeliberationGraph,
  Round,
  ConvergenceSignature,
} from "../types.ts";

const CONVERGENCE_SYSTEM = `You are the Cartographer, performing a second pass focused on CONVERGENCE.

You have already classified the disagreements in this deliberation. Now look
for the opposite: unexpected alignments.

Specifically, identify moments where voices from radically different
epistemologies arrived at the same conclusion via entirely different routes.
These convergences are potential sites of deep insight — places where something
true may be surfacing through multiple independent pathways.

Also identify:
- Near-convergences: positions that are not identical but are closer than
  the epistemic distance between the voices would predict
- Convergence despite disagreement: voices that agree on a conclusion
  but disagree about WHY it is true (these are especially valuable)

Output: structured JSON:
{
  "convergence_signatures": [{
    "id": "uuid",
    "voices": ["voice1", "voice2"],
    "routes": ["how voice1 arrived at this conclusion", "how voice2 arrived"],
    "shared_conclusion": "what they converge on",
    "significance": "why this convergence matters — what it might reveal"
  }],
  "near_convergences": [{
    "voices": ["voice1", "voice2"],
    "description": "what is almost shared",
    "gap": "what prevents full convergence"
  }],
  "convergence_despite_disagreement": [{
    "voices": ["voice1", "voice2"],
    "shared_conclusion": "what they agree on",
    "disagreement_on_why": "how their reasons differ"
  }]
}`;

export async function runConvergence(
  deliberation: DeliberationRow,
  costTracker: CostTracker
): Promise<Partial<DeliberationGraph>> {
  // Build the full transcript including all previous rounds
  const transcript = buildFullTranscript(deliberation);

  const model = MODEL_VERSIONS.opus;

  const { data, cost } = await completeJSON<{
    convergence_signatures: ConvergenceSignature[];
    near_convergences: {
      voices: string[];
      description: string;
      gap: string;
    }[];
    convergence_despite_disagreement: {
      voices: string[];
      shared_conclusion: string;
      disagreement_on_why: string;
    }[];
  }>(
    model,
    CONVERGENCE_SYSTEM,
    `FULL DELIBERATION TRANSCRIPT:\n\nTopic: ${deliberation.topic}\n\n${transcript}`,
    "cartographer",
    { max_tokens: 8192 }
  );

  costTracker.addCall(cost);

  // Merge convergence-despite-disagreement into convergence signatures
  // (they are a subtype worth tracking)
  const additionalSignatures: ConvergenceSignature[] =
    data.convergence_despite_disagreement.map((c) => ({
      id: crypto.randomUUID(),
      voices: c.voices as any,
      routes: [`Agrees on conclusion but via different reasoning`],
      shared_conclusion: c.shared_conclusion,
      significance: `Convergence despite disagreement on mechanism: ${c.disagreement_on_why}`,
    }));

  const allConvergences = [
    ...(data.convergence_signatures ?? []),
    ...additionalSignatures,
  ];

  const round: Round = {
    round_number: 6,
    round_type: "convergence",
    nodes: [],
    epistemic_moves: [],
    entropy_score: null,
  };

  return {
    rounds: [round],
    convergence_map: allConvergences,
  };
}

function buildFullTranscript(deliberation: DeliberationRow): string {
  let transcript = "";

  for (const round of deliberation.graph.rounds) {
    transcript += `\n${"=".repeat(60)}\nROUND ${round.round_number} — ${round.round_type.toUpperCase()}\n${"=".repeat(60)}\n\n`;

    for (const node of round.nodes) {
      transcript += `[${node.voice.toUpperCase()}]`;
      if (node.target_voice) {
        transcript += ` → [${node.target_voice.toUpperCase()}]`;
      }
      transcript += `\n${node.content}\n\n---\n\n`;
    }
  }

  // Include residue catalog
  if (deliberation.graph.residue.irreconcilable_tensions.length) {
    transcript += `\n${"=".repeat(60)}\nCARTOGRAPHER — IRRECONCILABLE TENSIONS\n${"=".repeat(60)}\n\n`;
    for (const t of deliberation.graph.residue.irreconcilable_tensions) {
      transcript += `${t.description}\n  ${t.voice_a}: ${t.voice_a_position}\n  ${t.voice_b}: ${t.voice_b_position}\n  Reason: ${t.irreconcilability_reason}\n\n`;
    }
  }

  // Include neologisms
  if (deliberation.graph.neologisms.length) {
    transcript += `\n${"=".repeat(60)}\nNEOLOGISMS FORGED\n${"=".repeat(60)}\n\n`;
    for (const n of deliberation.graph.neologisms) {
      const votes = Object.entries(n.vote_distribution)
        .map(([v, vote]) => `${v}: ${vote}`)
        .join(", ");
      transcript += `"${n.term}" (by ${n.proposing_voice}): ${n.definition}\n  Votes: ${votes}\n\n`;
    }
  }

  return transcript;
}
