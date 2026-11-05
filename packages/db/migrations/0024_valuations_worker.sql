-- Valuation and daily equity history (ADR 0020).
-- The demo account starts from the same $100,000 as an Alpaca paper account;
-- other accounts take their starting equity from the broker at the first valuation.
UPDATE trading_account AS a
   SET starting_equity = 100000
  FROM broker_connection AS b
 WHERE b.id = a.broker_connection_id AND b.provider = 'demo' AND a.starting_equity IS NULL;
--> statement-breakpoint
ALTER TABLE "account_valuation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "account_valuation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "account_valuation" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "account_valuation" TO tm_app;
--> statement-breakpoint
ALTER TABLE "book_valuation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "book_valuation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "book_valuation" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "book_valuation" TO tm_app;
--> statement-breakpoint
-- A final valuation is the record of that session's close and is never rewritten.
CREATE FUNCTION keep_final_valuation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.final THEN
    RAISE EXCEPTION 'a final valuation cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER account_valuation_keep_final BEFORE UPDATE ON "account_valuation"
  FOR EACH ROW EXECUTE FUNCTION keep_final_valuation();
--> statement-breakpoint
-- The worker claims accounts not valued recently, then values each in its tenant's scope.
CREATE FUNCTION claim_valuations(p_lease_seconds integer, p_every_seconds integer, p_limit integer)
  RETURNS TABLE (claimed_id uuid, claimed_user uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 OR p_every_seconds NOT BETWEEN 10 AND 86400
     OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid queue arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  UPDATE trading_account AS a
     SET valuation_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   WHERE a.id IN (
           SELECT t.id FROM trading_account AS t
            WHERE (t.valuation_lease_expires_at IS NULL OR t.valuation_lease_expires_at < now())
              AND (t.valued_at IS NULL OR t.valued_at < now() - make_interval(secs => p_every_seconds))
            ORDER BY t.valued_at NULLS FIRST
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit)
  RETURNING a.id, a.user_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_valuations(integer, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_valuations(integer, integer, integer) TO tm_app;
--> statement-breakpoint
CREATE TRIGGER account_valuation_notify
  AFTER INSERT OR UPDATE ON account_valuation
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
--> statement-breakpoint
-- Valuation leases and times change every few minutes; they are not account changes.
DROP TRIGGER trading_account_notify ON trading_account;
--> statement-breakpoint
CREATE TRIGGER trading_account_notify
  AFTER INSERT OR UPDATE OF nickname, external_id, masked_external_id, mode, currency,
    capabilities, is_default, is_active, last_synced_at, starting_equity ON trading_account
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
