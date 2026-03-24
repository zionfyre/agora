-- Schema updates for five-voice comparative analysis findings
-- voice_tier, requires_partner_review, corpus_note

-- voice_tier: 'tier_1' | 'tier_2' | 'mixed'
ALTER TABLE deliberations
  ADD COLUMN IF NOT EXISTS voice_tier TEXT NOT NULL DEFAULT 'tier_1';

-- requires_partner_review: flagged anomalies needing human review
ALTER TABLE deliberations
  ADD COLUMN IF NOT EXISTS requires_partner_review BOOLEAN DEFAULT false;

-- corpus_note: reason for flagging (human-readable)
ALTER TABLE deliberations
  ADD COLUMN IF NOT EXISTS corpus_note TEXT;

-- Index for filtering flagged records
CREATE INDEX IF NOT EXISTS idx_deliberations_requires_review
  ON deliberations(requires_partner_review) WHERE requires_partner_review = true;
CREATE INDEX IF NOT EXISTS idx_deliberations_voice_tier
  ON deliberations(voice_tier);
