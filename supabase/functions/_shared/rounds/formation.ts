// Round 1 — Independent Formation
// Each voice receives only the topic. No context from other agents.
// Responses logged before any agent sees another's output.
// Parallel API calls for all voices.

import { complete } from "../openrouter.ts";
import { resolveModel } from "../models.ts";
import { ACTIVE_VOICES, buildVoicePrompt } from "../voices.ts";
import { CostTracker } from "../cost-tracker.ts";
import { computeEntropy } from "../entropy.ts";
import type { DeliberationRow, DeliberationGraph, Round, Node } from "../types.ts";

const ROUND_INSTRUCTIONS = `You are participating in Round 1 — Independent Formation.

You have been given a topic for deliberation. You have NOT seen any other voice's response.
Produce your independent position on this topic.

Your response must:
1. State your position clearly, grounded in your epistemic framework
2. Identify what you consider the core question (which may differ from what other frameworks consider the core question)
3. Name at least one thing you cannot evaluate within your framework — a genuine limit, not false modesty
4. Be 400-800 words

Do NOT try to anticipate or preempt other voices. Speak from your framework alone.`;

export async function runFormation(
  deliberation: DeliberationRow,
  costTracker: CostTracker
): Promise<Partial<DeliberationGraph>> {
  const topicPrompt = formatTopicPrompt(deliberation);
  const nodes: Node[] = [];

  // Parallel calls — all voices see only the topic
  const results = await Promise.all(
    ACTIVE_VOICES.map(async (voice) => {
      const model = resolveModel(voice.name, "sonnet");
      const systemPrompt = buildVoicePrompt(voice, ROUND_INSTRUCTIONS);

      const result = await complete(
        model,
        systemPrompt,
        topicPrompt,
        voice.name
      );

      costTracker.addCall(result.cost);

      return {
        voice: voice.name,
        content: result.content,
      };
    })
  );

  for (const r of results) {
    nodes.push({
      id: crypto.randomUUID(),
      voice: r.voice,
      content: r.content,
      node_type: "thesis",
      target_voice: null,
      steelman_score: null,
      critique_type: null,
      confidence_markers: [],
      tags: [],
    });
  }

  // Entropy scoring — primary QA signal for tilt validation
  // Catches the most common failure mode (tilt degradation) before Round 2 fires
  const entropy = computeEntropy(nodes);

  console.log(
    `Formation entropy: ${entropy.entropy_score} ` +
      `(mean similarity: ${entropy.mean_similarity})`
  );
  for (const pair of entropy.pairwise_similarities) {
    console.log(
      `  ${pair.voice_a} ↔ ${pair.voice_b}: ${pair.similarity}`
    );
  }

  const round: Round = {
    round_number: 1,
    round_type: "formation",
    nodes,
    epistemic_moves: [],
    entropy_score: entropy.entropy_score,
  };

  return {
    rounds: [round],
    quality_flags: entropy.quality_flags.length > 0
      ? entropy.quality_flags
      : undefined,
  };
}

function formatTopicPrompt(deliberation: DeliberationRow): string {
  let prompt = `DELIBERATION TOPIC: ${deliberation.topic}\n`;

  if (deliberation.topic_context) {
    prompt += `\nCONTEXT: ${deliberation.topic_context}\n`;
  }

  if (deliberation.tension_axes?.length) {
    prompt += `\nTENSION AXES:\n`;
    for (const axis of deliberation.tension_axes) {
      prompt += `  - ${axis}\n`;
    }
  }

  prompt += `\nROUND: 1 — Independent Formation`;
  return prompt;
}
