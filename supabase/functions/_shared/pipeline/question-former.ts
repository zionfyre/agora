// Witness Council — Stage 2: Question Formation
// Produces a single, open focal point for the witness council.

import { completeJSON } from "../openrouter.ts";
import { MODEL_VERSIONS } from "../models.ts";
import type { EntryType, QuestionFormationOutput } from "../types.ts";

const QF_MODEL = MODEL_VERSIONS.sonnet;

const SYSTEM_PROMPT = `You form a single question that opens a submitted entry to witness. The question must be genuinely open — it should not pre-answer itself, should not choose between existing frameworks, and should not tell the witnesses what to look for. It is an invitation, not a brief. Return only valid JSON. No preamble. No markdown fences.`;

const USER_PROMPTS: Record<EntryType, (text: string) => string> = {
  question: (text) => `This entry is already a question. Your task is to determine whether it needs any clarifying expansion or whether it should be passed to the witness council exactly as submitted.

Entry:
${text}

Return:
{
  "question": "The question to present to the witness council. Either the original entry verbatim, or a minimal expansion if the original is too compressed to anchor a full testimony.",
  "passed_verbatim": true | false
}`,

  document: (text) => `A document has been submitted to the witness council. Your task is to form a single open question that gives each witness a genuine point of encounter with the document — without pre-framing what they should find, without summarizing the document's argument, and without choosing between its claims.

The question should name what the document is reaching toward, not what it concludes.

Document:
${text}

Return:
{
  "question": "The open question. One to three sentences. Does not summarize, does not choose a side, does not reproduce any binary the document argues against."
}`,

  creative: (text) => `A creative work has been submitted to the witness council. Your task is to form a single open question that gives each witness a point of encounter with the work — without interpreting it, without narrowing what it might mean, and without treating it as an argument to evaluate.

Entry:
${text}

Return:
{
  "question": "The open question. One to two sentences. Asks what the work makes present, not what it means."
}`,

  claim: (text) => `An empirical or factual claim has been submitted to the witness council. Your task is to form a single open question that gives each witness a genuine encounter with the claim — including what it assumes, what it stakes, and what ways of knowing it privileges or forecloses.

Entry:
${text}

Return:
{
  "question": "The open question. One to three sentences. Does not simply ask whether the claim is true — asks what is at stake in how we would know."
}`,

  hybrid: (text) => `A hybrid entry has been submitted. Use your judgment to form the most honest and open question given the nature of what was submitted. Do not force it into a single category.

Entry:
${text}

Return:
{
  "question": "The open question."
}`,
};

export async function formQuestion(
  entryText: string,
  entryType: EntryType
): Promise<{ question: string; passedVerbatim: boolean; cost: { prompt_tokens: number; completion_tokens: number; estimated_cost_usd: number } }> {
  const promptBuilder = USER_PROMPTS[entryType] ?? USER_PROMPTS.hybrid;

  const { data, cost } = await completeJSON<QuestionFormationOutput>(
    QF_MODEL,
    SYSTEM_PROMPT,
    promptBuilder(entryText),
    "falsificationist", // voice slot unused
    { temperature: 0.5, max_tokens: 512 }
  );

  return {
    question: data.question,
    passedVerbatim: data.passed_verbatim ?? false,
    cost,
  };
}
