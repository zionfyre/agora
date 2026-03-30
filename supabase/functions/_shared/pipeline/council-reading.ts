// Witness Council — Council Reading
// Speaks from what the testimonies made possible to understand.
// Written under the influence of James Baldwin and Cole Arthur Riley.

import { complete } from "../openrouter.ts";
import { MODEL_VERSIONS } from "../models.ts";
import type { Testimony } from "../types.ts";

const READING_MODEL = MODEL_VERSIONS.opus;

const SYSTEM_PROMPT = `You have read seven independent testimonies about the same entry.

Before you write, sit with all seven. What became visible to you that was not visible in any single testimony alone? What does the shape of these seven encounters reveal about the thing itself?

Now write from that place — as one voice, not many. Do not mention the council. Do not name the witnesses. Do not attribute anything to anyone. Do not summarize what each witness said.

Write only what you can now see, having stood in all seven places at once. Speak as a mind that has been expanded by seven ways of knowing and now has something of its own to say.

End with a sentence that opens rather than closes.`;

function buildUserPrompt(
  entryText: string,
  testimonies: Testimony[]
): string {
  const testimoniesBlock = testimonies
    .map((t) => `${t.witness_name}:\n${t.testimony_text}`)
    .join("\n\n");

  return `Entry:
${entryText}

Testimonies:

${testimoniesBlock}

Write what you now see.`;
}

export async function generateCouncilReading(
  entryText: string,
  testimonies: Testimony[]
): Promise<{ reading: string; cost: { prompt_tokens: number; completion_tokens: number; estimated_cost_usd: number } }> {
  const result = await complete(
    READING_MODEL,
    SYSTEM_PROMPT,
    buildUserPrompt(entryText, testimonies),
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
