-- Semantic deduplication for the Agora interface
-- Enable pgvector and add topic embeddings for similarity search

-- Enable the vector extension
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Add embedding column to deliberations
ALTER TABLE deliberations
  ADD COLUMN IF NOT EXISTS topic_embedding vector(1536);

-- Index for fast similarity search
CREATE INDEX IF NOT EXISTS idx_deliberations_topic_embedding
  ON deliberations
  USING ivfflat (topic_embedding vector_cosine_ops)
  WITH (lists = 20);

-- RPC function: find semantically similar completed deliberations
CREATE OR REPLACE FUNCTION match_deliberations(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.88,
  match_count int DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  topic text,
  topic_category topic_category,
  status deliberation_status,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    d.id,
    d.topic,
    d.topic_category,
    d.status,
    1 - (d.topic_embedding <=> query_embedding) AS similarity
  FROM deliberations d
  WHERE
    d.status = 'completed'
    AND d.topic_embedding IS NOT NULL
    AND 1 - (d.topic_embedding <=> query_embedding) > match_threshold
  ORDER BY d.topic_embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Backfill function: generate embeddings for existing deliberations
-- Called manually or via cron after deploying embedding pipeline
-- Placeholder — actual embedding generation happens in application code
COMMENT ON COLUMN deliberations.topic_embedding IS
  'OpenAI text-embedding-3-small (1536d). Populated on deliberation completion or via backfill.';
