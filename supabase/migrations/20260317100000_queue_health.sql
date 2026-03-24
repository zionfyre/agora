-- Queue health observability function for corpus-stats Edge Function
-- Returns queue depth, oldest message age, processing rate, VT hits, and last worker fire time.

create or replace function public.get_queue_health()
returns json
language plpgsql
security definer
as $$
declare
  _queue_depth       bigint;
  _oldest_age_sec    double precision;
  _processing_rate   bigint;
  _vt_hits           bigint;
  _worker_last_fired timestamptz;
  _result            json;
begin
  -- 1. queue_depth: visible messages (VT has expired, ready to be read)
  select count(*)
    into _queue_depth
    from pgmq.q_deliberation_rounds
   where vt <= now();

  -- 2. oldest_message_age_seconds
  select extract(epoch from now() - min(enqueued_at))
    into _oldest_age_sec
    from pgmq.q_deliberation_rounds;

  -- 3. processing_rate: messages archived in the last 10 minutes
  select count(*)
    into _processing_rate
    from pgmq.a_deliberation_rounds
   where archived_at > now() - interval '10 minutes';

  -- 4. visibility_timeout_hits: messages read more than once (VT expired, reappeared)
  select count(*)
    into _vt_hits
    from pgmq.q_deliberation_rounds
   where read_ct > 1;

  -- 5. worker_last_fired: most recent successful archive
  select max(archived_at)
    into _worker_last_fired
    from pgmq.a_deliberation_rounds;

  select json_build_object(
    'queue_depth',                coalesce(_queue_depth, 0),
    'oldest_message_age_seconds', coalesce(_oldest_age_sec, 0),
    'processing_rate',            coalesce(_processing_rate, 0),
    'visibility_timeout_hits',    coalesce(_vt_hits, 0),
    'worker_last_fired',          _worker_last_fired
  ) into _result;

  return _result;
end;
$$;

-- Allow the Edge Function (service role) to call this
grant execute on function public.get_queue_health() to service_role;
