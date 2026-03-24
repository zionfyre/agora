// Round 1 — Independent Formation
// Each voice receives only the topic. No context from other agents.
// Responses logged before any agent sees another's output.
// Parallel API calls for all voices.

import { complete } from "../openrouter.ts";
import { resolveModel } from "../models.ts";
import { ACTIVE_VOICES, buildVoicePrompt } from "../voices.ts";
import { CostTracker } from "../cost-tracker.ts";
import { computeEntropy } from "../entropy.ts";
import { retrieveCorpusPassages, formatSourceContext, hasTraditionCorpus } from "../corpus-retrieval.ts";
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
): Promise<Partial<DeliberationGraph> & { _ragAugmented?: boolean }> {
  const topicPrompt = formatTopicPrompt(deliberation);
  const nodes: Node[] = [];

  // Pre-fetch corpus passages for tradition voices (parallel with each other)
  const traditionVoices = ACTIVE_VOICES.filter((v) => hasTraditionCorpus(v.name));
  const corpusMap = new Map<string, string>();

  if (traditionVoices.length > 0) {
    const corpusResults = await Promise.all(
      traditionVoices.map(async (voice) => {
        const passages = await retrieveCorpusPassages(voice.name, deliberation.topic);
        return { voice: voice.name, sourceContext: formatSourceContext(passages) };
      })
    );
    for (const r of corpusResults) {
      if (r.sourceContext) corpusMap.set(r.voice, r.sourceContext);
    }
  }

  // Mark deliberation as RAG-augmented if any corpus data was retrieved
  const ragAugmented = corpusMap.size > 0;

  // Parallel calls — all voices see only the topic (tradition voices get source context)
  const results = await Promise.all(
    ACTIVE_VOICES.map(async (voice) => {
      const model = resolveModel(voice.name, "sonnet");
      const sourceContext = corpusMap.get(voice.name) ?? "";
      const roundInstructions = sourceContext
        ? `${ROUND_INSTRUCTIONS}${sourceContext}`
        : ROUND_INSTRUCTIONS;
      const systemPrompt = buildVoicePrompt(voice, roundInstructions);

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
    _ragAugmented: ragAugmented,
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
