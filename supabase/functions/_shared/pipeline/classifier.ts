// Witness Council — Stage 1: Input Classifier
// Routes the entry to the appropriate question formation path.

import { completeJSON } from "../openrouter.ts";
import { MODEL_VERSIONS } from "../models.ts";
import type { ClassifierOutput } from "../types.ts";

const CLASSIFIER_MODEL = MODEL_VERSIONS.sonnet;

const SYSTEM_PROMPT = `You identify what kind of entry has been submitted to a witness council. Return only valid JSON. No preamble. No markdown fences.`;

function buildUserPrompt(entryText: string): string {
  return `Classify this entry:

${entryText}

Return:
{
  "entry_type": "question" | "document" | "creative" | "claim" | "hybrid",
  "confidence": "high" | "medium" | "low",
  "note": "One sentence if confidence is medium or low. Otherwise null."
}

Definitions:
- question: A direct inquiry, poetic or philosophical, with no argumentative structure. "What life does a river hold in relation to the ocean?"
- document: A text with claims, evidence, and logical structure. Essays, papers, arguments.
- creative: A poem, story, lyric, or work whose primary mode is aesthetic rather than argumentative.
- claim: A factual assertion or empirical statement presented for evaluation.
- hybrid: Meaningfully combines two or more types above.`;
}

export async function classifyEntry(
  entryText: string
): Promise<{ result: ClassifierOutput; cost: { prompt_tokens: number; completion_tokens: number; estimated_cost_usd: number } }> {
  try {
    const { data, cost } = await completeJSON<ClassifierOutput>(
      CLASSIFIER_MODEL,
      SYSTEM_PROMPT,
      buildUserPrompt(entryText),
      "falsificationist", // voice slot unused, just for cost tracking
      { temperature: 0.2, max_tokens: 256 }
    );

    // Validate entry_type
    const validTypes = ["question", "document", "creative", "claim", "hybrid"];
    if (!validTypes.includes(data.entry_type)) {
      data.entry_type = "hybrid";
    }

    return { result: data, cost };
  } catch (err) {
    // Default to hybrid on failure — do not block the pipeline
    console.error(`Classifier failed: ${err instanceof Error ? err.message : err}`);
    return {
      result: { entry_type: "hybrid", confidence: "low", note: "Classifier failed, defaulting to hybrid" },
      cost: { prompt_tokens: 0, completion_tokens: 0, estimated_cost_usd: 0 },
    };
  }
}
