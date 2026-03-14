// Round 2 — Steelmanning
// Each voice sees all Round 1 thesis nodes and must steelman every other voice.
// Target voice then scores each steelman 1-5.
// Failed steelmans (1-2) are epistemic opacity events — high-value signal.

import { complete, completeJSON } from "../openrouter.ts";
import { resolveModel } from "../models.ts";
import { ACTIVE_VOICES, buildVoicePrompt } from "../voices.ts";
import { CostTracker } from "../cost-tracker.ts";
import type {
  DeliberationRow,
  DeliberationGraph,
  Round,
  Node,
  VoiceName,
} from "../types.ts";

const STEELMAN_INSTRUCTIONS = `You are participating in Round 2 — Steelmanning.

You have received all voices' independent positions from Round 1.
For EACH other voice, produce a steelman of their position — a version
so accurate and compelling that the original voice would say:
"yes, that's my view fairly rendered."

For each steelman:
1. Name the voice you are steelmanning
2. Render their position in the strongest possible form, from WITHIN their framework
3. Do not critique — only represent. This requires temporarily inhabiting their ontology.
4. Each steelman should be 150-300 words

This is not about agreement. It is about comprehension across epistemic boundaries.`;

const SCORING_INSTRUCTIONS = `You are scoring steelman attempts of your position.

For each steelman attempt below, rate it 1-5:
  5 = Perfect — this is my view, stated better than I stated it
  4 = Strong — captures the essential structure with minor gaps
  3 = Passing — gets the main point but misses important nuance
  2 = Weak — understands the surface but not the epistemic foundations
  1 = Failed — this is a caricature, not a steelman

Respond as JSON: { "scores": [{ "steelman_by": "<voice>", "score": <1-5>, "reason": "<brief>" }] }`;

export async function runSteelman(
  deliberation: DeliberationRow,
  costTracker: CostTracker
): Promise<Partial<DeliberationGraph>> {
  // Get Round 1 thesis nodes
  const round1 = deliberation.graph.rounds.find((r) => r.round_number === 1);
  if (!round1) throw new Error("Round 1 not found — cannot steelman");

  const thesesText = round1.nodes
    .map((n) => `[${n.voice.toUpperCase()}]\n${n.content}`)
    .join("\n\n---\n\n");

  const steelmanNodes: Node[] = [];

  // Each voice steelmans all others (parallel across voices)
  const steelmanResults = await Promise.all(
    ACTIVE_VOICES.map(async (voice) => {
      const model = resolveModel(voice.name, "sonnet");
      const systemPrompt = buildVoicePrompt(voice, STEELMAN_INSTRUCTIONS);
      const userPrompt = `Here are all Round 1 positions:\n\n${thesesText}\n\nYOUR VOICE: ${voice.displayName}\nProduce steelmans of every OTHER voice's position.`;

      const result = await complete(model, systemPrompt, userPrompt, voice.name);
      costTracker.addCall(result.cost);

      return { voice: voice.name, content: result.content };
    })
  );

  // Parse steelman content into individual nodes per target voice
  for (const r of steelmanResults) {
    const otherVoices = ACTIVE_VOICES.filter((v) => v.name !== r.voice);
    for (const target of otherVoices) {
      steelmanNodes.push({
        id: crypto.randomUUID(),
        voice: r.voice,
        content: r.content, // Full steelman block — extraction is post-processing
        node_type: "steelman",
        target_voice: target.name,
        steelman_score: null, // Scored in next step
        critique_type: null,
        confidence_markers: [],
        tags: [],
      });
    }
  }

  // Score steelmans — each voice scores steelmans targeting it
  // Uses lightweight model tier (simple 1-5 classification)
  for (const targetVoice of ACTIVE_VOICES) {
    const myThesis = round1.nodes.find((n) => n.voice === targetVoice.name);
    if (!myThesis) continue;

    const steelmansOfMe = steelmanResults.filter(
      (r) => r.voice !== targetVoice.name
    );

    const scoringPrompt = `Your original position (Round 1):\n${myThesis.content}\n\nSteelman attempts of your position:\n${steelmansOfMe
      .map((s) => `[By ${s.voice.toUpperCase()}]\n${s.content}`)
      .join("\n\n---\n\n")}`;

    const model = resolveModel(targetVoice.name, "lightweight");
    const systemPrompt = buildVoicePrompt(targetVoice, SCORING_INSTRUCTIONS);

    try {
      const { data, cost } = await completeJSON<{
        scores: { steelman_by: string; score: number; reason: string }[];
      }>(model, systemPrompt, scoringPrompt, targetVoice.name);

      costTracker.addCall(cost);

      // Apply scores to nodes
      for (const score of data.scores) {
        const matchingNode = steelmanNodes.find(
          (n) =>
            n.target_voice === targetVoice.name &&
            n.voice === score.steelman_by
        );
        if (matchingNode) {
          matchingNode.steelman_score = Math.max(
            1,
            Math.min(5, Math.round(score.score))
          ) as 1 | 2 | 3 | 4 | 5;
        }
      }
    } catch (err) {
      console.warn(
        `Steelman scoring failed for ${targetVoice.name}: ${err}`
      );
      // Non-fatal — steelmans still exist, just unscored
    }
  }

  const round: Round = {
    round_number: 2,
    round_type: "steelman",
    nodes: steelmanNodes,
    epistemic_moves: [],
    entropy_score: null,
  };

  return { rounds: [round] };
}
