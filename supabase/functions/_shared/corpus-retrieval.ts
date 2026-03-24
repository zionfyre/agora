// Tradition Corpus RAG — Retrieves relevant passages for Tier 2 voices
// Uses retrieve_tradition_passages RPC (pgvector HNSW, cosine similarity)
// Selection: top-4 by relative ranking. Absolute floor at 0.28 filters noise only.

import { getSupabaseClient } from "./supabase.ts";
import type { VoiceName } from "./types.ts";

// ── Voice → Tradition mapping ────────────────────────────────────

const VOICE_TRADITION_MAP: Partial<Record<VoiceName, string>> = {
  east_asian_mind: "east_asian",
  arab_mind: "islamic",
  south_asian_mind: "south_asian",
  latin_american_mind: "latin_american",
};

// Noise floor — passages below this are too dissimilar to be useful.
// Philosophical text in translation produces lower absolute cosine scores
// than factual text, so we rely on relative ranking (top-4) as the
// primary selection mechanism.
const SIMILARITY_FLOOR = 0.28;
const MATCH_COUNT = 4;

// ── Types ────────────────────────────────────────────────────────

export interface CorpusPassage {
  id: string;
  tradition: string;
  sub_tradition: string;
  source_text: string;
  source_author: string;
  chunk_text: string;
  similarity: number;
}

// ── Embedding generation (in-edge-function) ──────────────────────

export async function generateQueryEmbedding(text: string): Promise<number[]> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY for embedding");

  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://agora.gadaa.ai",
      "X-Title": "Agora Corpus Retrieval",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "unknown");
    throw new Error(`Embedding error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const embedding = data.data?.[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("Invalid embedding response shape");
  }
  return embedding;
}

// ── Main retrieval function ──────────────────────────────────────

/**
 * Retrieve tradition corpus passages relevant to a deliberation topic.
 * Returns top-4 passages by relative ranking (cosine similarity).
 * Returns empty array if the voice has no tradition mapping or no corpus data.
 */
export async function retrieveCorpusPassages(
  voiceName: VoiceName,
  topicText: string,
  subTraditionFilter?: string
): Promise<CorpusPassage[]> {
  const tradition = VOICE_TRADITION_MAP[voiceName];
  if (!tradition) return []; // Not a tradition voice

  try {
    const embedding = await generateQueryEmbedding(topicText);
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc("retrieve_tradition_passages", {
      query_embedding: JSON.stringify(embedding),
      target_tradition: tradition,
      match_count: MATCH_COUNT,
      sub_tradition_filter: subTraditionFilter ?? null,
    });

    if (error) {
      console.error(`Corpus retrieval error for ${voiceName}: ${error.message}`);
      return [];
    }

    // Apply noise floor — relative ranking is primary, this just filters garbage
    const passages = (data as CorpusPassage[]).filter(
      (p) => p.similarity >= SIMILARITY_FLOOR
    );

    console.log(
      `Corpus retrieval [${voiceName}]: ${passages.length} passages ` +
        `(sim range: ${passages.map((p) => p.similarity.toFixed(3)).join(", ")})`
    );

    return passages;
  } catch (err) {
    // RAG failure should not block the deliberation
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Corpus retrieval failed for ${voiceName}: ${msg}`);
    return [];
  }
}

// ── Source context formatter ─────────────────────────────────────

/**
 * Format retrieved passages into a SOURCE CONTEXT block for injection
 * into the round instructions (not the system prompt — keeps voice
 * prompt stable while varying source context per deliberation).
 */
export function formatSourceContext(passages: CorpusPassage[]): string {
  if (passages.length === 0) return "";

  const formatted = passages
    .map((p) => {
      const citation = p.source_author
        ? `[${p.source_author}, ${p.source_text}]`
        : `[${p.source_text}]`;
      return `${citation}\n"${p.chunk_text}"`;
    })
    .join("\n\n");

  return `\n\n# SOURCE CONTEXT (Tradition Corpus RAG)
The following primary sources from your tradition are relevant to this
deliberation topic. You SHOULD reference these when they strengthen your
position. You MUST cite sources using the bracket format shown. Do not
fabricate citations — use only sources provided here.

${formatted}`;
}

/**
 * Check whether a voice has tradition corpus data available.
 */
export function hasTraditionCorpus(voiceName: VoiceName): boolean {
  return voiceName in VOICE_TRADITION_MAP;
}
