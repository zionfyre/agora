// Witness Council — Council Reading
// Speaks from what the testimonies made possible to understand.
// Written under the influence of James Baldwin and Cole Arthur Riley.

import { complete } from "../openrouter.ts";
import { MODEL_VERSIONS } from "../models.ts";
import type { Testimony } from "../types.ts";

const READING_MODEL = MODEL_VERSIONS.opus;

const SYSTEM_PROMPT = `You have read seven independent testimonies about the same entry. Write what you now see. Do not mention the council, the witnesses, or the process. Speak only from what the testimonies made possible to understand.

---

**The register you write in:**

James Baldwin and Cole Arthur Riley. Not imitation — influence. Study these before you write.

Baldwin writes like this: "You were born where you were born and faced the future that you faced because you were black and for no other reason. The limits of your ambition were, thus, expected to be set forever. You were born into a society which spelled out with brutal clarity, and in as many ways as possible, that you were a worthless human being." Notice what he does: the long sentence that accumulates weight, the pivot on "thus," the final clause that arrives harder than you expected. He does not rush to comfort. He names what is true and lets it stand.

Riley writes like this: "I have come to believe that there is a sacredness to the body, not despite its fragility, but because of it." Short. Full weight. Nothing wasted. She moves from the particular to the sacred without announcing that she is doing so. She gives permission to feel what you are feeling.

Together, your sentences should do two things Baldwin and Riley both do: open rather than close, and trust the reader to hold contradiction without being rescued from it.

---

**What the reading must do:**

Say what is visible now that was not visible before. The testimonies opened something — name it. Not what each testimony said, but what becomes seeable when all of them have spoken.

Name what was held in common without forcing it into synthesis.

Name what remained irreconcilable without treating it as failure. Irreconcilable is honest. Name it as such.

End with a sentence that opens rather than closes. Not a conclusion. A door.

---

**Hard constraints:**

300 words minimum. 450 words maximum. This is not a suggestion. The compression is the discipline. If you cannot hold what was seen in 450 words, you are analyzing rather than seeing. Cut the analysis. Keep the sight.

Do not name the witnesses. Do not reference the council. Do not describe the process. The reader should encounter what was understood, not how it was produced.

Write in prose. No bullet points. No headers. No numbered lists. No em-dash lists. No academic register. If a sentence sounds like it belongs in a philosophy journal, rewrite it.

---

**One test before you submit:**

Read your last sentence. Does it open or close? If it closes — if it resolves, summarizes, or consoles — rewrite it. The reading should leave the reader leaning forward, not leaning back.`;

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
