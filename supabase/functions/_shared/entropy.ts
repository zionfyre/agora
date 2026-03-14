// The Agora Project — Entropy Scoring
// Pairwise cosine similarity across Round 1 formations.
// Uses TF-IDF term vectors (no external API needed).
//
// Entropy score = 1 - mean_pairwise_cosine_similarity
//   < 0.3 → voices too similar → flag for prompt review
//   > 0.9 → no overlap at all → flag for topic review
//   0.3–0.9 → productive range

import type { Node, QualityFlag } from "./types.ts";

/**
 * Tokenize text into a term frequency map.
 * Strips common stop words and keeps tokens >= 3 chars.
 */
function tokenize(text: string): Map<string, number> {
  const STOP_WORDS = new Set([
    "the", "and", "that", "this", "with", "from", "have", "has", "had",
    "not", "but", "are", "was", "were", "been", "being", "for", "its",
    "can", "may", "will", "would", "could", "should", "does", "did",
    "they", "them", "their", "there", "here", "what", "which", "when",
    "where", "who", "how", "than", "then", "also", "into", "more",
    "about", "between", "through", "because", "while", "each", "other",
    "some", "such", "only", "very", "just", "any", "all", "both",
    "most", "own", "same", "these", "those", "over", "under",
  ]);

  const tokens =
    text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
  const freq = new Map<string, number>();

  for (const token of tokens) {
    if (!STOP_WORDS.has(token)) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }

  return freq;
}

/**
 * Cosine similarity between two term frequency vectors.
 * Returns 0.0–1.0 (always non-negative for TF vectors).
 */
function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>
): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  // Only iterate over shared keys for dot product
  for (const [key, va] of a) {
    normA += va * va;
    const vb = b.get(key);
    if (vb !== undefined) {
      dotProduct += va * vb;
    }
  }

  for (const vb of b.values()) {
    normB += vb * vb;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface EntropyResult {
  entropy_score: number; // 0.0–1.0
  mean_similarity: number;
  pairwise_similarities: {
    voice_a: string;
    voice_b: string;
    similarity: number;
  }[];
  quality_flags: QualityFlag[];
}

/**
 * Compute entropy score from Round 1 thesis nodes.
 * Returns the score + any quality flags triggered.
 */
export function computeEntropy(nodes: Node[]): EntropyResult {
  if (nodes.length < 2) {
    return {
      entropy_score: 1.0,
      mean_similarity: 0,
      pairwise_similarities: [],
      quality_flags: [],
    };
  }

  // Tokenize all nodes
  const vectors = nodes.map((n) => ({
    voice: n.voice,
    vector: tokenize(n.content),
  }));

  // Compute all pairwise similarities
  const pairwise: { voice_a: string; voice_b: string; similarity: number }[] =
    [];

  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const similarity = cosineSimilarity(
        vectors[i].vector,
        vectors[j].vector
      );
      pairwise.push({
        voice_a: vectors[i].voice,
        voice_b: vectors[j].voice,
        similarity: Math.round(similarity * 1000) / 1000,
      });
    }
  }

  // Mean similarity
  const meanSimilarity =
    pairwise.reduce((sum, p) => sum + p.similarity, 0) / pairwise.length;

  // Entropy = 1 - mean similarity
  const entropyScore = Math.round((1 - meanSimilarity) * 1000) / 1000;

  // Quality flags
  const qualityFlags: QualityFlag[] = [];

  if (entropyScore < 0.3) {
    qualityFlags.push({
      type: "low_entropy",
      severity: "warning",
      message: `Entropy score ${entropyScore} (< 0.3) — voices too similar. Review prompts for tilt degradation.`,
      round: 1,
    });

    // Identify the most similar pair
    const mostSimilar = pairwise.reduce((a, b) =>
      a.similarity > b.similarity ? a : b
    );
    qualityFlags.push({
      type: "high_similarity_pair",
      severity: "info",
      message: `Most similar pair: ${mostSimilar.voice_a} ↔ ${mostSimilar.voice_b} (${mostSimilar.similarity})`,
      round: 1,
    });
  }

  if (entropyScore > 0.9) {
    qualityFlags.push({
      type: "high_entropy",
      severity: "info",
      message: `Entropy score ${entropyScore} (> 0.9) — very low overlap. Topic may be too abstract or voices not engaging with same question.`,
      round: 1,
    });
  }

  return {
    entropy_score: entropyScore,
    mean_similarity: Math.round(meanSimilarity * 1000) / 1000,
    pairwise_similarities: pairwise,
    quality_flags: qualityFlags,
  };
}
