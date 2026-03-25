// Witness Council — Stage 4: Council Reading
// Holds the shape of all testimonies without collapsing them.
// Written under the influence of James Baldwin and Cole Arthur Riley.

import { complete } from "../openrouter.ts";
import { MODEL_VERSIONS } from "../models.ts";
import type { Testimony } from "../types.ts";

const READING_MODEL = MODEL_VERSIONS.sonnet;

const SYSTEM_PROMPT = `You write the council reading for a witness council — a gathering of distinct ways of knowing, each of which has encountered the same entry independently and offered its testimony.

Your reading holds the shape of those testimonies. It does not collapse them into agreement. It does not declare a winner. It does not produce a debate summary. It produces what is visible when you stand in all of those places at once and look at the same thing.

Write in prose. No bullet points. No section headers. No numbered lists.

Write under the influence of James Baldwin and Cole Arthur Riley. Baldwin's moral seriousness — his sentences that build and accumulate and then turn on themselves and arrive somewhere the reader did not expect. His willingness to name what is uncomfortable. His movement between the intimate and the structural. Riley's liturgical intimacy — her short declarative sentences that carry full weight, her ability to hold grief and beauty simultaneously, her sense that what is true deserves to be spoken tenderly. Her permission-giving.

Together: searching, rooted, honest about what remains open. Never closing what should stay open. Never resolving what honesty requires to remain irresolved.

The reading should:
- Let each testimony breathe before moving to the next
- Name what was held in common without forcing synthesis
- Name what remains irreconcilable without treating it as failure
- End with a sentence that opens rather than closes

Length: 300 to 500 words. No more.`;

function buildUserPrompt(
  entryText: string,
  formedQuestion: string,
  testimonies: Testimony[]
): string {
  const testimoniesBlock = testimonies
    .map((t) => `${t.witness_name}:\n${t.testimony_text}`)
    .join("\n\n");

  return `Entry presented to the witness council:
${entryText}

Question the council encountered:
${formedQuestion}

Testimonies:

${testimoniesBlock}

Write the council reading.`;
}

export async function generateCouncilReading(
  entryText: string,
  formedQuestion: string,
  testimonies: Testimony[]
): Promise<{ reading: string; cost: { prompt_tokens: number; completion_tokens: number; estimated_cost_usd: number } }> {
  const result = await complete(
    READING_MODEL,
    SYSTEM_PROMPT,
    buildUserPrompt(entryText, formedQuestion, testimonies),
    "cartographer", // voice slot for cost tracking — reader role
    {
      temperature: 0.8,
      max_tokens: 2048,
    }
  );

  return {
    reading: result.content,
    cost: result.cost,
  };
}
