-- How long paper orders took from the moment they were due to the moment they
-- were submitted to the broker (§19 target: under 5 s). Run after a paper
-- strategy has traded: psql "$DATABASE_URL" -f load/orders.sql
WITH timings AS (
  SELECT extract(epoch FROM b.submitted_at - i.eligible_at) AS seconds
    FROM broker_order b
    JOIN order_intent i ON i.id = b.intent_id
   WHERE b.submitted_at IS NOT NULL
     -- A leg whose due time had already passed when the strategy started (a
     -- shifted test clock, or a queued session) says nothing about latency.
     AND b.submitted_at >= i.eligible_at
)
SELECT
  count(*) AS orders,
  round(avg(seconds)::numeric, 3) AS avg_seconds,
  round((percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds))::numeric, 3) AS p95_seconds,
  round(max(seconds)::numeric, 3) AS worst_seconds,
  count(*) FILTER (WHERE seconds > 5) AS over_target
FROM timings;
