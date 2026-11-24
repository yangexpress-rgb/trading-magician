CREATE TABLE "ml_frozen_as_of" (
	"model_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ml_frozen_as_of_pkey" PRIMARY KEY("model_id","as_of")
);
--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_kind";--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_kind" CHECK ("notification"."kind" in ('strategy_started', 'strategy_stopped', 'triggered', 'order_rejected', 'order_canceled', 'partial_fill', 'filled', 'disconnect', 'stale_data', 'risk_pause', 'reconciliation_mismatch', 'billing', 'share_received', 'share_accepted', 'share_declined', 'storage_alert'));--> statement-breakpoint
-- Research Store split (ADR 0115, N331). While research data still sits in
-- this database (no RESEARCH_DATABASE_URL), the same table answers here.
GRANT SELECT, INSERT ON "ml_frozen_as_of" TO tm_secrets;--> statement-breakpoint
-- A back test's trades are stored apart from its run and replaced if the run is saved again.
GRANT DELETE ON "backtest_trade" TO tm_app;--> statement-breakpoint
INSERT INTO ml_frozen_as_of (model_id, as_of)
  SELECT DISTINCT r.model_id, p.as_of FROM ml_prediction p JOIN ml_model_run r ON r.id = p.model_run_id
  ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The Research Store's account purge, here for the single-database setup:
-- the worker calls it after purge_deleted_accounts (ADR 0115).
CREATE FUNCTION purge_research_users(p_user_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_rows integer := 0;
  v_n integer;
BEGIN
  DELETE FROM backtest_trade WHERE user_id = ANY (p_user_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;
  DELETE FROM pattern_occurrence WHERE user_id = ANY (p_user_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;
  DELETE FROM pattern WHERE user_id = ANY (p_user_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;
  DELETE FROM pattern_scan WHERE user_id = ANY (p_user_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_rows := v_rows + v_n;
  RETURN v_rows;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_research_users(uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_research_users(uuid[]) TO tm_secrets;
--> statement-breakpoint
-- Retention trims (ADR 0115). Each runs as a definer function the worker's
-- batch role may call; nothing else may delete these rows.
--
-- Notifications expire after p_days.
CREATE FUNCTION expire_notifications(p_days integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  IF p_days < 30 THEN RAISE EXCEPTION 'notifications are kept at least 30 days'; END IF;
  DELETE FROM notification WHERE created_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION expire_notifications(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION expire_notifications(integer) TO tm_secrets;--> statement-breakpoint
-- The audit log stays append-only for everyone; the one exception is this
-- expiry, which marks its own transaction before deleting rows past p_days.
CREATE FUNCTION reject_audit_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_expiry', true) = 'on'
     AND OLD.occurred_at < now() - interval '365 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_event is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;--> statement-breakpoint
DROP TRIGGER audit_event_no_update_delete ON "audit_event";--> statement-breakpoint
CREATE TRIGGER audit_event_no_update_delete BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_change();--> statement-breakpoint
CREATE FUNCTION expire_audit_events(p_days integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  IF p_days < 365 THEN RAISE EXCEPTION 'audit events are kept at least 365 days'; END IF;
  PERFORM set_config('app.audit_expiry', 'on', true);
  DELETE FROM audit_event WHERE occurred_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.audit_expiry', 'off', true);
  RETURN v_n;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION expire_audit_events(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION expire_audit_events(integer) TO tm_secrets;--> statement-breakpoint
-- Position snapshots older than p_days keep one row a day: the last of each
-- account, instrument and source for that New York day.
CREATE FUNCTION thin_position_snapshots(p_days integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  IF p_days < 30 THEN RAISE EXCEPTION 'intraday snapshots are kept at least 30 days'; END IF;
  DELETE FROM position_snapshot p
   USING (
     SELECT id, row_number() OVER (
       PARTITION BY account_id, instrument_id, source, (as_of AT TIME ZONE 'America/New_York')::date
       ORDER BY as_of DESC, created_at DESC, id DESC) AS rn
       FROM position_snapshot
      WHERE as_of < now() - make_interval(days => p_days)
   ) d
   WHERE p.id = d.id AND d.rn > 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION thin_position_snapshots(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION thin_position_snapshots(integer) TO tm_secrets;--> statement-breakpoint
-- Research Store integrity (ADR 0115): which of these users and back test
-- runs still exist in Core, so the sweep can drop research rows of the rest.
CREATE FUNCTION core_users_present(p_ids uuid[]) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM "user" WHERE id = ANY (p_ids)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION core_users_present(uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION core_users_present(uuid[]) TO tm_secrets;--> statement-breakpoint
CREATE FUNCTION core_backtest_runs_present(p_ids uuid[]) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM backtest_run WHERE id = ANY (p_ids)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION core_backtest_runs_present(uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION core_backtest_runs_present(uuid[]) TO tm_secrets;--> statement-breakpoint
-- Database size for the storage alert, readable by the worker's batch role.
CREATE FUNCTION storage_bytes() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pg_database_size(current_database())
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION storage_bytes() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION storage_bytes() TO tm_secrets;--> statement-breakpoint
-- Research Store integrity sweep (ADR 0115): the owners and back test runs
-- research rows belong to, so the worker can drop those Core no longer has.
CREATE FUNCTION research_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT user_id FROM backtest_trade UNION SELECT user_id FROM pattern_scan
  UNION SELECT user_id FROM pattern UNION SELECT user_id FROM pattern_occurrence
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION research_user_ids() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION research_user_ids() TO tm_secrets;--> statement-breakpoint
CREATE FUNCTION research_trade_run_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT run_id FROM backtest_trade
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION research_trade_run_ids() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION research_trade_run_ids() TO tm_secrets;--> statement-breakpoint
CREATE FUNCTION delete_research_trades(p_run_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM backtest_trade WHERE run_id = ANY (p_run_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION delete_research_trades(uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delete_research_trades(uuid[]) TO tm_secrets;
--> statement-breakpoint
-- The Window Contract's boundary check (ADR 0115): research tables that still
-- hold rows in this database. Empty once the move is verified and cleared.
CREATE FUNCTION research_tables_in_core() RETURNS SETOF text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t text; n integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['option_contract', 'option_chain_snapshot', 'factor_snapshot',
    'factor_coverage', 'pattern_scan', 'pattern', 'pattern_occurrence', 'ml_feature_snapshot',
    'ml_label', 'ml_evaluation', 'ml_report', 'ml_frozen_as_of', 'backtest_trade'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = t AND relkind = 'r') THEN
      EXECUTE format('SELECT 1 FROM %I LIMIT 1', t);
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN RETURN NEXT t; END IF;
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION research_tables_in_core() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION research_tables_in_core() TO tm_secrets;
--> statement-breakpoint
-- While the research tables share this database, each prediction also marks
-- its date frozen here, so the snapshot job reads one marker table either way.
CREATE FUNCTION ml_prediction_marks_frozen() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO ml_frozen_as_of (model_id, as_of)
    SELECT r.model_id, NEW.as_of FROM ml_model_run r WHERE r.id = NEW.model_run_id
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER ml_prediction_marks_frozen AFTER INSERT ON "ml_prediction"
  FOR EACH ROW EXECUTE FUNCTION ml_prediction_marks_frozen();
--> statement-breakpoint
REVOKE ALL ON FUNCTION ml_prediction_marks_frozen() FROM PUBLIC;
