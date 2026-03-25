-- The Agora Project — Witness Council Architecture (witness-v1)
-- Replaces 6-round deliberation with: classify → form question → parallel witness → reading

-- ── 1. New columns on deliberations ──────────────────────────────

ALTER TABLE deliberations
  ADD COLUMN IF NOT EXISTS entry_type TEXT,
  ADD COLUMN IF NOT EXISTS formed_question TEXT,
  ADD COLUMN IF NOT EXISTS council_reading TEXT,
  ADD COLUMN IF NOT EXISTS architecture_version TEXT DEFAULT 'witness-v1',
  ADD COLUMN IF NOT EXISTS partial_council BOOLEAN DEFAULT FALSE;

-- ── 2. Backfill existing records as deliberation-v1 ──────────────

UPDATE deliberations
  SET architecture_version = 'deliberation-v1'
  WHERE architecture_version IS NULL OR architecture_version = 'witness-v1';

-- ── 3. Testimonies table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS testimonies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deliberation_id UUID NOT NULL REFERENCES deliberations(id) ON DELETE CASCADE,
  witness_id TEXT NOT NULL,
  witness_name TEXT NOT NULL,
  model TEXT NOT NULL,
  testimony_text TEXT NOT NULL,
  token_count INTEGER,
  thinking_enabled BOOLEAN DEFAULT FALSE,
  thinking_token_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS testimonies_deliberation_idx
  ON testimonies(deliberation_id);

-- ── 4. RLS on testimonies ────────────────────────────────────────

ALTER TABLE testimonies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_testimonies" ON testimonies
  FOR SELECT USING (true);
