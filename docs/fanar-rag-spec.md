# Fanar RAG Integration Spec — Arab Mind Voice

## Status: SPEC ONLY — Do not build until Islamic studies scholar review

## Purpose

The Arab Mind voice approximates Islamic intellectual traditions through prompt
engineering alone. Fanar RAG augments this by retrieving authentic source texts
(Quran, Hadith, classical tafsir, usul al-fiqh) relevant to each deliberation
topic, injecting them as grounding context alongside the voice's system prompt.

The name "Fanar" (فنار — lighthouse) signals the function: illuminating the
deliberation with primary sources, not replacing scholarly interpretation.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│ Topic text   │────▶│ Fanar Query  │────▶│ Vector store     │
│ + round ctx  │     │ Builder      │     │ (Islamic corpus) │
└─────────────┘     └──────────────┘     └────────┬─────────┘
                                                   │
                                          top-k chunks
                                                   │
                                          ┌────────▼─────────┐
                                          │ Citation Formatter│
                                          │ (surah:ayah,      │
                                          │  hadith ref, etc) │
                                          └────────┬─────────┘
                                                   │
                                          injected into
                                          Arab Mind prompt
                                                   ▼
                                          ┌──────────────────┐
                                          │ Arab Mind voice   │
                                          │ system prompt +   │
                                          │ SOURCE CONTEXT    │
                                          └──────────────────┘
```

## Corpus Sources (requires scholar review)

| Source | Description | Format | Priority |
|--------|-------------|--------|----------|
| Quran (Arabic + Sahih International EN) | Complete text, surah:ayah indexed | Verse-level chunks | P0 |
| Sahih al-Bukhari | Authenticated hadith collection | Hadith-level chunks with isnad metadata | P0 |
| Sahih Muslim | Authenticated hadith collection | Same format | P0 |
| Al-Ghazali, *Ihya Ulum al-Din* | Classical Islamic philosophy | Section-level chunks | P1 |
| Ibn Rushd, *Tahafut al-Tahafut* | Rationalist tradition | Section-level chunks | P1 |
| Ibn Khaldun, *Muqaddimah* | Social science / historiography | Section-level chunks | P1 |
| Al-Shatibi, *Al-Muwafaqat* | Usul al-fiqh (legal theory) | Section-level chunks | P2 |

**Scholar review gate**: The corpus selection, chunking strategy, and retrieval
quality must be reviewed by an Islamic studies scholar before activation. The
review should verify:
1. Source authenticity and edition quality
2. Translation accuracy (where applicable)
3. Appropriate chunking that preserves scholarly context
4. No misrepresentation of positions through decontextualization

## Query Builder

Input: topic statement + round context (what other voices have said)

Strategy:
1. Extract key concepts from the topic
2. Map concepts to Islamic scholarly categories (fiqh, aqidah, falsafa, tasawwuf)
3. Generate embedding query combining topic + category signals
4. Retrieve top-k=5 chunks, deduplicated by source
5. Rank by relevance score, filter below threshold 0.65

## Citation Format

All retrieved sources MUST be cited in the Arab Mind's output using this format:

```
[Quran 2:256] "There shall be no compulsion in [acceptance of] the religion."
[Bukhari 1:1] The Prophet (PBUH) said: "Actions are judged by intentions..."
[Ibn Rushd, Tahafut al-Tahafut, §3.12] "The philosopher and the theologian..."
```

The citation block is appended to the system prompt as:

```
# SOURCE CONTEXT (Fanar RAG)
The following primary sources are relevant to this deliberation topic.
You SHOULD reference these when they strengthen your position. You MUST
cite sources using the bracket format shown. Do not fabricate citations
— use only sources provided here.

[sources inserted here]
```

## Integration Point

In `state-machine.ts`, before calling the Arab Mind voice:

```typescript
if (voice.name === "arab_mind") {
  const sources = await fanarRetrieve(topic, roundContext);
  const sourceBlock = formatFanarSources(sources);
  // Inject into round instructions, not system prompt
  roundInstructions = `${roundInstructions}\n\n${sourceBlock}`;
}
```

This keeps the voice's system prompt stable while varying the source context
per deliberation.

## Vector Store Options

| Option | Pros | Cons |
|--------|------|------|
| Supabase pgvector | Already in stack, no new infra | Embedding generation needed |
| Pinecone | Managed, fast | New dependency, cost |
| Local FAISS (in Edge Function) | No external calls | Cold start, memory limits |

**Recommendation**: Supabase pgvector — keeps everything in the existing stack.
New table `fanar_sources` with columns: `id`, `source_ref`, `source_type`,
`text_ar`, `text_en`, `embedding vector(1536)`, `metadata jsonb`.

## Activation Prerequisites

1. [ ] Corpus assembled and loaded into vector store
2. [ ] Islamic studies scholar reviews corpus + retrieval quality
3. [ ] Scholar signs off on citation format and contextual accuracy
4. [ ] Dry-run: 3 deliberations with Fanar-augmented Arab Mind, scholar reviews output
5. [ ] Strategic session confirms activation alongside other Tier 2 voices
6. [ ] `ACTIVATE_ARAB_MIND=true` set in environment

## Cost Estimate

- Embedding generation (one-time): ~$2-5 for full corpus via OpenAI text-embedding-3-small
- Per-deliberation retrieval: negligible (pgvector query)
- No additional LLM cost — sources are injected into existing prompt
