// Round 5 — Neologism Forging
// Where the Cartographer found incommensurable disagreements,
// voices propose new terms to name the space between positions
// without collapsing them. Then all voices vote.

import { complete, completeJSON } from "../openrouter.ts";
import { resolveModel } from "../models.ts";
import { ACTIVE_VOICES, buildVoicePrompt } from "../voices.ts";
import { CostTracker } from "../cost-tracker.ts";
import type {
  DeliberationRow,
  DeliberationGraph,
  Round,
  Node,
  Neologism,
  VoiceName,
} from "../types.ts";

const NEOLOGISM_INSTRUCTIONS = `You are participating in Round 5 — Neologism Forging.

The Cartographer has identified deep epistemic, ontological, or incommensurable
tensions in this deliberation — places where positions cannot be reconciled
without epistemic loss, or where the frameworks disagree about what counts
as valid evidence or what is real.

Your task: for each tension presented, propose a NEW TERM that names the
space between the positions WITHOUT collapsing them.

The goal is NOT to resolve the tension. It is to give it a name that makes it
available for future deliberation.

For each neologism you propose:
1. The term itself (a new word or compound)
2. A definition (2-3 sentences)
3. Which irreconcilable tension it names
4. Why existing vocabulary is insufficient

Respond as JSON:
{
  "proposals": [{
    "term": "your-new-term",
    "definition": "2-3 sentence definition",
    "tension_described": "brief description of the tension",
    "why_new_word": "why existing vocabulary fails"
  }]
}`;

const VOTING_INSTRUCTIONS = `You are voting on proposed neologisms.

For each proposed term, vote:
- "yes": This names something real that previously had no name
- "no": This prematurely resolves the tension or is unnecessary
- "partial": The impulse is right but the term needs refinement (explain)

Respond as JSON:
{
  "votes": [{
    "term": "the-term",
    "vote": "yes|no|partial",
    "reason": "brief explanation"
  }]
}`;

export async function runNeologism(
  deliberation: DeliberationRow,
  costTracker: CostTracker
): Promise<Partial<DeliberationGraph>> {
  // Neologism forging triggers on epistemic, ontological, and incommensurable
  // tensions — all three are territory where existing vocabulary fails
  const tensions = deliberation.graph.residue.irreconcilable_tensions;

  if (!tensions.length) {
    console.log("No epistemic/ontological/incommensurable tensions — skipping neologism round");
    return {
      rounds: [
        {
          round_number: 5,
          round_type: "neologism",
          nodes: [],
          epistemic_moves: [],
          entropy_score: null,
        },
      ],
    };
  }

  const tensionText = tensions
    .map(
      (t, i) =>
        `Tension ${i + 1}: ${t.description}\n  ${t.voice_a} position: ${t.voice_a_position}\n  ${t.voice_b} position: ${t.voice_b_position}\n  Irreconcilability: ${t.irreconcilability_reason}`
    )
    .join("\n\n");

  // Phase 1: Collect neologism proposals (parallel)
  const allProposals: {
    voice: VoiceName;
    proposals: { term: string; definition: string; tension_described: string }[];
  }[] = [];

  const proposalResults = await Promise.all(
    ACTIVE_VOICES.map(async (voice) => {
      const model = resolveModel(voice.name, "sonnet");
      const systemPrompt = buildVoicePrompt(voice, NEOLOGISM_INSTRUCTIONS);
      const userPrompt = `IRRECONCILABLE TENSIONS:\n\n${tensionText}\n\nYOUR VOICE: ${voice.displayName}\nPropose neologisms for as many tensions as you find productive.`;

      try {
        const { data, cost } = await completeJSON<{
          proposals: {
            term: string;
            definition: string;
            tension_described: string;
            why_new_word: string;
          }[];
        }>(model, systemPrompt, userPrompt, voice.name);

        costTracker.addCall(cost);
        return { voice: voice.name, proposals: data.proposals };
      } catch (err) {
        console.warn(`Neologism proposal failed for ${voice.name}: ${err}`);
        return { voice: voice.name, proposals: [] };
      }
    })
  );

  allProposals.push(...proposalResults);

  // Flatten all proposed terms
  const allTerms = allProposals.flatMap((p) =>
    p.proposals.map((prop) => ({
      ...prop,
      proposing_voice: p.voice,
    }))
  );

  if (!allTerms.length) {
    return {
      rounds: [
        {
          round_number: 5,
          round_type: "neologism",
          nodes: [],
          epistemic_moves: [],
          entropy_score: null,
        },
      ],
    };
  }

  // Phase 2: All voices vote on all proposals (parallel)
  const termList = allTerms
    .map(
      (t) =>
        `Term: "${t.term}" (proposed by ${t.proposing_voice})\nDefinition: ${t.definition}\nTension: ${t.tension_described}`
    )
    .join("\n\n---\n\n");

  const neologisms: Neologism[] = allTerms.map((t) => ({
    id: crypto.randomUUID(),
    term: t.term,
    definition: t.definition,
    proposing_voice: t.proposing_voice,
    tension_id: "", // Linked in post-processing
    vote_distribution: {} as Record<VoiceName, "yes" | "no" | "partial">,
    refinements: [],
  }));

  // Voting (parallel, lightweight model)
  await Promise.all(
    ACTIVE_VOICES.map(async (voice) => {
      const model = resolveModel(voice.name, "lightweight");
      const systemPrompt = buildVoicePrompt(voice, VOTING_INSTRUCTIONS);
      const userPrompt = `PROPOSED NEOLOGISMS:\n\n${termList}\n\nYOUR VOICE: ${voice.displayName}\nVote on each term.`;

      try {
        const { data, cost } = await completeJSON<{
          votes: { term: string; vote: "yes" | "no" | "partial"; reason: string }[];
        }>(model, systemPrompt, userPrompt, voice.name);

        costTracker.addCall(cost);

        for (const vote of data.votes) {
          const neo = neologisms.find((n) => n.term === vote.term);
          if (neo) {
            neo.vote_distribution[voice.name] = vote.vote;
            if (vote.vote === "partial") {
              neo.refinements.push({ voice: voice.name, text: vote.reason });
            }
          }
        }
      } catch (err) {
        console.warn(`Neologism voting failed for ${voice.name}: ${err}`);
      }
    })
  );

  // Build nodes from proposals
  const nodes: Node[] = allTerms.map((t) => ({
    id: crypto.randomUUID(),
    voice: t.proposing_voice,
    content: `**${t.term}**: ${t.definition}`,
    node_type: "neologism_proposal" as const,
    target_voice: null,
    steelman_score: null,
    critique_type: null,
    confidence_markers: [],
    tags: [],
  }));

  const round: Round = {
    round_number: 5,
    round_type: "neologism",
    nodes,
    epistemic_moves: [],
    entropy_score: null,
  };

  return { rounds: [round], neologisms };
}
