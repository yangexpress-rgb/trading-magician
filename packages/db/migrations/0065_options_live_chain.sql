CREATE TABLE "option_live_chain" (
	"symbol" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"chain_time" timestamp with time zone,
	"view" jsonb,
	"message" text,
	CONSTRAINT "option_live_chain_status" CHECK ("option_live_chain"."status" in ('pending', 'ready', 'failed')),
	CONSTRAINT "option_live_chain_symbol" CHECK ("option_live_chain"."symbol" ~ '^[A-Z][A-Z0-9.]{0,9}$')
);
--> statement-breakpoint
-- The live chain for Research › Options (ADR 0048). Public data with no tenant,
-- like the daily signals: the worker (tm_secrets) writes it, the app login reads
-- it and asks for a chain only through request_option_chain.
GRANT SELECT, INSERT, UPDATE, DELETE ON "option_live_chain" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "option_live_chain" TO tm_app;--> statement-breakpoint
-- Asks the worker for a symbol's chain unless one is pending, or one was stored
-- in the last 15 minutes (the cache), or one failed in the last minute. A stored
-- view stays on the row while it is refreshed. At most 50 chains wait at once.
CREATE FUNCTION request_option_chain(p_symbol text)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  waiting integer;
  result text;
BEGIN
  IF p_symbol IS NULL OR p_symbol !~ '^[A-Z][A-Z0-9.]{0,9}$' THEN
    RAISE EXCEPTION 'invalid symbol' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT count(*) INTO waiting FROM option_live_chain
   WHERE status = 'pending' AND requested_at > now() - interval '10 minutes';
  IF waiting >= 50 AND NOT EXISTS (
    SELECT 1 FROM option_live_chain WHERE symbol = p_symbol AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'too many option chains are waiting' USING ERRCODE = 'program_limit_exceeded';
  END IF;
  INSERT INTO option_live_chain AS c (symbol) VALUES (p_symbol)
  ON CONFLICT (symbol) DO UPDATE
     SET status = 'pending', requested_at = now(), attempts = 0, lease_expires_at = NULL
   WHERE (c.status = 'ready' AND c.finished_at < now() - interval '15 minutes')
      OR (c.status = 'failed' AND c.finished_at < now() - interval '1 minute');
  SELECT status INTO result FROM option_live_chain WHERE symbol = p_symbol;
  RETURN result;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION request_option_chain(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION request_option_chain(text) TO tm_app;
