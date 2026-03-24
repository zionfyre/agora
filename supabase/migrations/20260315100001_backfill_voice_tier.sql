-- Backfill voice_tier and partner_status for existing records

-- All 41 four-voice deliberations: Tier 1, no partner dependency
UPDATE deliberations
  SET voice_tier = 'tier_1'
  WHERE created_at < '2026-03-15T13:48:04.268794+00:00';

-- All 20 five-voice deliberations: Tier 1, RO pending
UPDATE deliberations
  SET voice_tier = 'tier_1',
      partner_status = 'PENDING'
  WHERE created_at >= '2026-03-15T13:48:04.268794+00:00';
