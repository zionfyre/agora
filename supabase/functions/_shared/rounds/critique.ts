// Round 3 — Constrained Critique
// Voices critique other positions using INTERNAL critique only:
// "Within your framework, here is a tension you have not addressed."
// External critiques are flagged, not rejected.

import { complete } from "../openrouter.ts";
import { resolveModel } from "../models.ts";
import { ACTIVE_VOICES, buildVoicePrompt } from "../voices.ts";
import { CostTracker } from "../cost-tracker.ts";
import type {
  DeliberationRow,
  DeliberationGraph,
  Round,
  Node,
  QualityFlag,
} from "../types.ts";

const CRITIQUE_INSTRUCTIONS = `You are participating in Round 3 — Constrained Critique.

You may critique any other voice's position — but ONLY using internal critique.

The constraint: "Within YOUR framework, here is a tension YOU have not addressed."
NOT: "Your framework is wrong."

This means you must engage with each epistemology on its own terms. Find the
places where a voice's position is inconsistent with its own stated principles,
where it has not followed through on its own logic, or where its own blind spots
are creating problems it hasn't acknowledged.

For each critique:
1. Name the target voice
2. State the internal tension you've identified
3. Explain why this is a problem within THEIR framework (not yours)
4. Each critique should be 100-250 words

You must produce at least one critique. You may critique as many voices as you find productive.

If you find yourself wanting to say "your framework is wrong" — stop. That is an
external critique. Transform it into: "within your framework, this doesn't follow."`;

export async function runCritique(
  deliberation: DeliberationRow,
  costTracker: CostTracker
): Promise<Partial<DeliberationGraph>> {
  const round1 = deliberation.graph.rounds.find((r) => r.round_number === 1);
  const round2 = deliberation.graph.rounds.find((r) => r.round_number === 2);

  if (!round1) throw new Error("Round 1 not found — cannot critique");

  // Build context: Round 1 theses + Round 2 steelman highlights
  let context = "ROUND 1 — Original Positions:\n\n";
  for (const node of round1.nodes) {
    context += `[${node.voice.toUpperCase()}]\n${node.content}\n\n---\n\n`;
  }

  if (round2) {
    context += "ROUND 2 — Key steelman exchanges are on record.\n\n";
  }

  const nodes: Node[] = [];
  const qualityFlags: QualityFlag[] = [];

  // Parallel critique generation
  const results = await Promise.all(
    ACTIVE_VOICES.map(async (voice) => {
      const model = resolveModel(voice.name, "sonnet");
      const systemPrompt = buildVoicePrompt(voice, CRITIQUE_INSTRUCTIONS);
      const userPrompt = `${context}YOUR VOICE: ${voice.displayName}\nROUND: 3 — Constrained Critique\n\nProduce your internal critiques.`;

      const result = await complete(model, systemPrompt, userPrompt, voice.name);
      costTracker.addCall(result.cost);

      return { voice: voice.name, content: result.content };
    })
  );

  for (const r of results) {
    // Simple heuristic to detect external critiques:
    // phrases like "your framework is wrong", "fundamentally flawed",
    // "should abandon", "is incorrect"
    const externalMarkers = [
      /your (?:framework|approach|epistemology) is (?:wrong|flawed|incorrect)/i,
      /should (?:abandon|reject|give up)/i,
      /fundamentally (?:wrong|flawed|mistaken)/i,
    ];
    const hasExternalCritique = externalMarkers.some((m) =>
      m.test(r.content)
    );

    nodes.push({
      id: crypto.randomUUID(),
      voice: r.voice,
      content: r.content,
      node_type: "critique",
      target_voice: null, // Multiple targets — parsed in post-processing
      steelman_score: null,
      critique_type: hasExternalCritique ? "external" : "internal",
      confidence_markers: [],
      tags: hasExternalCritique ? ["external_critique_detected"] : [],
    });

    if (hasExternalCritique) {
      qualityFlags.push({
        type: "external_critique",
        severity: "warning",
        message: `${r.voice} produced external critique in Round 3 — flagged for review`,
        round: 3,
      });
    }
  }

  const round: Round = {
    round_number: 3,
    round_type: "critique",
    nodes,
    epistemic_moves: [],
    entropy_score: null,
  };

  return { rounds: [round], quality_flags: qualityFlags };
}
