-- The Agora Project — Queue Infrastructure Migration
-- Replaces fire-and-forget self-invocation with pgmq guaranteed delivery.

-- ── 1. Enable extensions ────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- pg_cron is pre-installed on Supabase hosted projects

-- ── 2. Create queues ────────────────────────────────────────────────

SELECT pgmq.create('deliberation_rounds');
SELECT pgmq.create('deliberation_results');

-- ── 3. PostgREST wrapper functions ──────────────────────────────────
-- pgmq functions live in the pgmq schema; PostgREST exposes public schema.
-- These thin wrappers make queue operations callable from Edge Functions.

CREATE OR REPLACE FUNCTION public.queue_send(
  p_queue_name TEXT,
  p_msg JSONB
) RETURNS BIGINT
LANGUAGE SQL SECURITY DEFINER
AS $$ SELECT pgmq.send(p_queue_name, p_msg) $$;

CREATE OR REPLACE FUNCTION public.queue_read(
  p_queue_name TEXT,
  p_vt INTEGER DEFAULT 60,
  p_qty INTEGER DEFAULT 1
) RETURNS TABLE (
  msg_id BIGINT,
  read_ct INTEGER,
  enqueued_at TIMESTAMPTZ,
  vt TIMESTAMPTZ,
  message JSONB
)
LANGUAGE SQL SECURITY DEFINER
AS $$ SELECT msg_id, read_ct, enqueued_at, vt, message FROM pgmq.read(p_queue_name, p_vt, p_qty) $$;

CREATE OR REPLACE FUNCTION public.queue_archive(
  p_queue_name TEXT,
  p_msg_id BIGINT
) RETURNS BOOLEAN
LANGUAGE SQL SECURITY DEFINER
AS $$ SELECT pgmq.archive(p_queue_name, p_msg_id) $$;

CREATE OR REPLACE FUNCTION public.queue_set_vt(
  p_queue_name TEXT,
  p_msg_id BIGINT,
  p_vt INTEGER
) RETURNS TABLE (
  msg_id BIGINT,
  read_ct INTEGER,
  enqueued_at TIMESTAMPTZ,
  vt TIMESTAMPTZ,
  message JSONB
)
LANGUAGE SQL SECURITY DEFINER
AS $$ SELECT msg_id, read_ct, enqueued_at, vt, message FROM pgmq.set_vt(p_queue_name, p_msg_id, p_vt) $$;

-- ── 4. pg_cron trigger functions ────────────────────────────────────
-- Calls the round-worker Edge Function via pg_net HTTP POST.
-- URL and key hardcoded in function body (SECURITY DEFINER — only
-- callable by postgres role). More reliable than database settings
-- which require ALTER DATABASE permissions.

CREATE OR REPLACE FUNCTION public.trigger_round_worker()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  _url TEXT := 'https://sapmcykznwmeaddbojtv.supabase.co/functions/v1/round-worker';
  _key TEXT := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhcG1jeWt6bndtZWFkZGJvanR2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0MDQwMTEzMiwiZXhwIjoyMDU1OTc3MTMyfQ.1m9QYkWb-o0PvBJl7T-tLORFaejLRfBdq6y67-_RJJ4';
BEGIN
  PERFORM net.http_post(
    url := _url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _key,
      'Content-Type', 'application/json'
    ),
    body := '{"batch_size": 5}'::jsonb
  );
END;
$$;

-- Delayed variant for the 30s offset job
CREATE OR REPLACE FUNCTION public.trigger_round_worker_delayed()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  _url TEXT := 'https://sapmcykznwmeaddbojtv.supabase.co/functions/v1/round-worker';
  _key TEXT := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhcG1jeWt6bndtZWFkZGJvanR2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0MDQwMTEzMiwiZXhwIjoyMDU1OTc3MTMyfQ.1m9QYkWb-o0PvBJl7T-tLORFaejLRfBdq6y67-_RJJ4';
BEGIN
  PERFORM pg_sleep(30);
  PERFORM net.http_post(
    url := _url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _key,
      'Content-Type', 'application/json'
    ),
    body := '{"batch_size": 5}'::jsonb
  );
END;
$$;

-- ── 5. Schedule pg_cron jobs ────────────────────────────────────────
-- Two jobs staggered by 30s = effective 30-second polling.

SELECT cron.schedule(
  'rounds-poll-a',
  '* * * * *',
  'SELECT public.trigger_round_worker()'
);

SELECT cron.schedule(
  'rounds-poll-b',
  '* * * * *',
  'SELECT public.trigger_round_worker_delayed()'
);

-- ── 6. Orphan sweep ────────────────────────────────────────────────
-- Safety net: catches deliberations where the round completed + persisted
-- but the enqueue-next step failed. Runs every 5 minutes.

CREATE OR REPLACE FUNCTION public.sweep_orphaned_deliberations()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  orphan RECORD;
  recovered INTEGER := 0;
BEGIN
  FOR orphan IN
    SELECT d.id, d.current_round
    FROM deliberations d
    WHERE d.status NOT IN ('completed', 'failed', 'pending')
      AND d.updated_at < NOW() - INTERVAL '10 minutes'
      AND NOT EXISTS (
        SELECT 1
        FROM pgmq.q_deliberation_rounds q
        WHERE (q.message->>'deliberation_id')::UUID = d.id
      )
  LOOP
    PERFORM pgmq.send('deliberation_rounds', jsonb_build_object(
      'deliberation_id', orphan.id,
      'round_number', orphan.current_round + 1
    ));
    recovered := recovered + 1;
    RAISE NOTICE 'Sweep: re-enqueued deliberation % for round %',
      orphan.id, orphan.current_round + 1;
  END LOOP;

  RETURN recovered;
END;
$$;

SELECT cron.schedule(
  'sweep-orphans',
  '*/5 * * * *',
  'SELECT public.sweep_orphaned_deliberations()'
);
