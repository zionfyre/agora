-- Brief 2, Part 1: Tradition Corpus RAG Infrastructure
-- pgvector extension already enabled (20260322000000_topic_embedding.sql)

-- ── tradition_corpus table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS tradition_corpus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tradition TEXT NOT NULL CHECK (tradition IN (
    'east_asian', 'islamic', 'south_asian', 'latin_american'
  )),
  sub_tradition TEXT,  -- e.g. 'confucian', 'sunni_rationalist', 'nyaya', 'liberation_theology'
  source_text TEXT NOT NULL,       -- title of source work
  source_author TEXT,              -- author or attribution
  chunk_text TEXT NOT NULL,        -- the actual passage
  chunk_index INTEGER NOT NULL,    -- ordering within source
  embedding extensions.vector(1536) NOT NULL, -- text-embedding-3-small
  metadata JSONB DEFAULT '{}',     -- flexible: translator, edition, url, license, etc.
  requires_partner_review BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),

  -- Idempotency: same source + chunk index = same row
  UNIQUE (tradition, source_text, chunk_index)
);

-- ── HNSW index for fast similarity search ───────────────────────
-- HNSW over IVFFlat: no training step, better recall, worth the
-- slightly higher memory for a corpus under 100k chunks.
CREATE INDEX idx_tradition_corpus_embedding
  ON tradition_corpus
  USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── Supporting indexes ──────────────────────────────────────────
CREATE INDEX idx_tradition_corpus_tradition ON tradition_corpus (tradition);
CREATE INDEX idx_tradition_corpus_sub_tradition ON tradition_corpus (sub_tradition);

-- ── Retrieval function ──────────────────────────────────────────
-- Called by the deliberation engine before voice formation calls.
-- Returns top-k passages from a specific tradition, optionally
-- filtered by sub_tradition.
CREATE OR REPLACE FUNCTION retrieve_tradition_passages(
  query_embedding extensions.vector(1536),
  target_tradition TEXT,
  match_count INTEGER DEFAULT 4,
  sub_tradition_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  tradition TEXT,
  sub_tradition TEXT,
  source_text TEXT,
  source_author TEXT,
  chunk_text TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    tc.id,
    tc.tradition,
    tc.sub_tradition,
    tc.source_text,
    tc.source_author,
    tc.chunk_text,
    1 - (tc.embedding <=> query_embedding) AS similarity
  FROM tradition_corpus tc
  WHERE tc.tradition = target_tradition
    AND (sub_tradition_filter IS NULL OR tc.sub_tradition = sub_tradition_filter)
  ORDER BY tc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ── RAG tracking on deliberations ───────────────────────────────
ALTER TABLE deliberations
  ADD COLUMN IF NOT EXISTS rag_augmented BOOLEAN DEFAULT false;

-- ── RLS policies ────────────────────────────────────────────────
-- Corpus is read-only for anon/authenticated, write via service role
ALTER TABLE tradition_corpus ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tradition_corpus_read"
  ON tradition_corpus FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "tradition_corpus_service_write"
  ON tradition_corpus FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
