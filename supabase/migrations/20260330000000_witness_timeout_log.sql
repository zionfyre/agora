-- Add witness_timeout_log to track per-witness timeouts for monitoring
ALTER TABLE deliberations
  ADD COLUMN IF NOT EXISTS witness_timeout_log JSONB DEFAULT '[]'::jsonb;
