// Round 2 — Steelmanning
// Per-pair generation: each voice steelmans each other voice individually.
// All generation calls run in parallel (20 calls for 5 voices).
// Scoring parallelized across target voices.
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

You will receive ONE other voice's position from Round 1.
Produce a steelman of their position — a version so accurate and compelling
that the original voice would say: "yes, that's my view fairly rendered."

1. Render their position in the strongest possible form, from WITHIN their framework
2. Do not critique — only represent. This requires temporarily inhabiting their ontology.
3. Your steelman should be 150-300 words

This is not about agreement. It is about comprehension across epistemic boundaries.`;

const SCORING_INSTRUCTIONS = `You are scoring steelman attempts of your position.

For each steelman attempt below, rate it 1-5:
  5 = Perfect — this is my view, stated better than I stated it
  4 = Strong — captures the essential structure with minor gaps
  3 = Passing — gets the main point but misses important nuance
  2 = Weak — understands the surface but not the epistemic foundations
  1 = Failed — this is a caricature, not a steelman

Respond with ONLY a JSON object. No explanation before or after. No markdown.
First character must be {, last character must be }.

{"scores": [{"steelman_by": "<voice_name>", "score": <1-5>, "reason": "<one sentence>"}]}`;

// Structured output schema for scoring — eliminates JSON parse failures
const SCORING_SCHEMA = {
  name: "steelman_scores",
  schema: {
    type: "object" as const,
    properties: {
      scores: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            steelman_by: { type: "string" as const },
            score: { type: "integer" as const },
            reason: { type: "string" as const },
          },
          required: ["steelman_by", "score", "reason"],
        },
      },
    },
    required: ["scores"],
  },
};

interface SteelmanPairResult {
  source: VoiceName;
  target: VoiceName;
  content: string;
}

export async function runSteelman(
  deliberation: DeliberationRow,
  costTracker: CostTracker
): Promise<Partial<DeliberationGraph>> {
  // Get Round 1 thesis nodes
  const round1 = deliberation.graph.rounds.find((r) => r.round_number === 1);
  if (!round1) throw new Error("Round 1 not found — cannot steelman");

  // ── Per-pair steelman generation ────────────────────────────────
  // Each (source, target) pair gets its own focused API call.
  // Anthropic voices process targets sequentially for prompt caching.
  // Non-Anthropic voices fire all targets in parallel.
  // All voices include full formation context for better steelmanning.

  const targetTheses = new Map(
    round1.nodes.map((n) => [n.voice, n.content])
  );

  // Shared formation context — all theses, built once, included in every call.
  // Gives each voice awareness of the full deliberation landscape when
  // steelmanning any target. Same prefix across calls from the same voice
  // enables prompt caching on Anthropic models.
  const formationContext = round1.nodes
    .map((n) => `[${n.voice.toUpperCase()}]\n${n.content}`)
    .join("\n\n---\n\n");

  // Group by source voice. Anthropic voices process targets sequentially
  // (200ms stagger) so the system+context prefix caches after call 1.
  // Non-Anthropic voices fire all targets in parallel (no caching benefit).
  const steelmanResults = await Promise.allSettled(
    ACTIVE_VOICES.map(async (source) => {
      const model = resolveModel(source.name, "sonnet");
      const systemPrompt = buildVoicePrompt(source, STEELMAN_INSTRUCTIONS);
      const isAnthropicVoice = model.startsWith("anthropic/");

      const targets = ACTIVE_VOICES.filter((t) => t.name !== source.name);

      if (isAnthropicVoice) {
        // Sequential with stagger — cache populates after call 1
        const results: SteelmanPairResult[] = [];
        for (const target of targets) {
          const userPrompt = `ROUND 1 FORMATION — ALL POSITIONS:\n\n${formationContext}\n\n---\n\nSTEELMAN TARGET: ${target.displayName}\nRender their position in the strongest possible form, from within their framework.`;

          const result = await complete(
            model,
            systemPrompt,
            userPrompt,
            source.name
          );
          costTracker.addCall(result.cost);
          results.push({
            source: source.name,
            target: target.name,
            content: result.content,
          });
        }
        return results;
      } else {
        // Non-Anthropic: all targets in parallel, target thesis only (no caching benefit)
        const results = await Promise.allSettled(
          targets.map(async (target) => {
            const targetContent = targetTheses.get(target.name);
            const userPrompt = `TARGET VOICE: ${target.displayName}\n\nTheir Round 1 position:\n${targetContent}\n\nSteelman this position from within their framework. Inhabit their ontology.`;

            const result = await complete(
              model,
              systemPrompt,
              userPrompt,
              source.name
            );
            costTracker.addCall(result.cost);
            return {
              source: source.name,
              target: target.name,
              content: result.content,
            } as SteelmanPairResult;
          })
        );
        return results
          .filter((r): r is PromiseFulfilledResult<SteelmanPairResult> => r.status === "fulfilled")
          .map((r) => r.value);
      }
    })
  );

  // Collect successful results, log failures
  const completedSteelmans: SteelmanPairResult[] = [];
  let generationFailures = 0;

  for (const result of steelmanResults) {
    if (result.status === "fulfilled") {
      completedSteelmans.push(...result.value);
    } else {
      generationFailures++;
      console.warn(`Steelman generation failed: ${result.reason}`);
    }
  }

  if (generationFailures > 0) {
    console.warn(
      `${generationFailures}/${ACTIVE_VOICES.length} voice groups had steelman generation failures`
    );
  }

  // Build steelman nodes from per-pair results
  const steelmanNodes: Node[] = completedSteelmans.map((r) => ({
    id: crypto.randomUUID(),
    voice: r.source,
    content: r.content,
    node_type: "steelman",
    target_voice: r.target,
    steelman_score: null,
    critique_type: null,
    confidence_markers: [],
    tags: [],
  }));

  // ── Parallel scoring ──────────────────────────────────────────
  // Each target voice scores all steelmans of their position.
  // Uses lightweight model tier (simple 1-5 classification).
  // Circuit breaker: after 2 retries per voice, log null scores.

  const SCORING_MAX_RETRIES = 2;
  let nullScoreCount = 0;

  const scoringResults = await Promise.allSettled(
    ACTIVE_VOICES.map(async (targetVoice) => {
      const myThesis = targetTheses.get(targetVoice.name);
      if (!myThesis) return;

      const steelmansOfMe = completedSteelmans.filter(
        (r) => r.target === targetVoice.name
      );
      if (steelmansOfMe.length === 0) return;

      const scoringPrompt = `Your original position (Round 1):\n${myThesis}\n\nSteelman attempts of your position:\n${steelmansOfMe
        .map((s) => `[By ${s.source.toUpperCase()}]\n${s.content}`)
        .join("\n\n---\n\n")}`;

      const model = resolveModel(targetVoice.name, "lightweight");
      const systemPrompt = buildVoicePrompt(
        targetVoice,
        SCORING_INSTRUCTIONS
      );

      let scored = false;
      for (let retry = 0; retry <= SCORING_MAX_RETRIES; retry++) {
        try {
          const { data, cost } = await completeJSON<{
            scores: {
              steelman_by: string;
              score: number;
              reason: string;
            }[];
          }>(model, systemPrompt, scoringPrompt, targetVoice.name, {
            json_schema: SCORING_SCHEMA,
          });

          costTracker.addCall(cost);

          // Apply scores to nodes
          // Normalize steelman_by: models return display names, uppercase,
          // or system names — match case-insensitively and flexibly
          for (const score of data.scores) {
            const byNorm = score.steelman_by
              .toLowerCase()
              .replace(/^the\s+/, "")
              .replace(/\s+/g, "_");
            const matchingNode = steelmanNodes.find(
              (n) =>
                n.target_voice === targetVoice.name &&
                n.voice.toLowerCase().includes(byNorm.slice(0, 6))
            );
            if (matchingNode) {
              matchingNode.steelman_score = Math.max(
                1,
                Math.min(5, Math.round(score.score))
              ) as 1 | 2 | 3 | 4 | 5;
            }
          }
          scored = true;
          break;
        } catch (err) {
          console.warn(
            `Steelman scoring attempt ${retry + 1}/${
              SCORING_MAX_RETRIES + 1
            } failed for ${targetVoice.name}: ${err}`
          );
          if (retry < SCORING_MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
          }
        }
      }

      if (!scored) {
        // Circuit breaker: log null scores, don't block the round
        console.warn(
          `Scoring circuit breaker: ${targetVoice.name} scores logged as null (scoring_unavailable)`
        );
        const unscoredNodes = steelmanNodes.filter(
          (n) =>
            n.target_voice === targetVoice.name &&
            n.steelman_score == null
        );
        nullScoreCount += unscoredNodes.length;
        for (const node of unscoredNodes) {
          node.tags = [...(node.tags ?? []), "scoring_unavailable"];
        }
      }
    })
  );

  // Log any scoring-level failures from Promise.allSettled
  for (const result of scoringResults) {
    if (result.status === "rejected") {
      console.error(`Scoring promise rejected: ${result.reason}`);
    }
  }

  // Flag deliberations with excessive null scores
  const qualityFlags = [];
  if (nullScoreCount > 2) {
    qualityFlags.push({
      type: "scoring_instability",
      severity: "warning" as const,
      message: `${nullScoreCount} steelman scores unavailable — scoring circuit breaker triggered`,
      round: 2 as const,
    });
  }

  const round: Round = {
    round_number: 2,
    round_type: "steelman",
    nodes: steelmanNodes,
    epistemic_moves: [],
    entropy_score: null,
  };

  return {
    rounds: [round],
    ...(qualityFlags.length > 0 ? { quality_flags: qualityFlags } : {}),
  };
}
