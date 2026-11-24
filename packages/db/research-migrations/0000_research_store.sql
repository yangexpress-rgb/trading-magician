-- Research Store (ADR 0115, N331): the separated database for research data.
-- It holds the bulky working data that execution never reads: factor
-- snapshots, raw option chains, pattern scans, patterns and occurrences, ML
-- training data,
-- and back test trades. The Core Store keeps everything execution reads.
--
-- Same group roles as Core (tm_app for the web and worker, tm_secrets for the
-- worker's batch jobs), same row-level security. Foreign keys that would point
-- at Core tables (instrument, user, ml_model, pattern, backtest_run) are not
-- possible across databases; the app checks those ids, and the daily retention
-- job removes rows whose Core parent is gone (ADR 0115 §Integrity).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tm_app') THEN
    CREATE ROLE tm_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tm_secrets') THEN
    CREATE ROLE tm_secrets NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO tm_app, tm_secrets;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_current_user_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_user_id() TO tm_app;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE option_right AS ENUM ('call', 'put');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint






CREATE TABLE backtest_trade (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    run_id uuid NOT NULL,
    cycle integer NOT NULL,
    status text NOT NULL,
    entry_time timestamp with time zone,
    exit_time timestamp with time zone,
    gross_pnl numeric NOT NULL,
    costs numeric NOT NULL,
    net_pnl numeric NOT NULL,
    return_pct numeric,
    legs jsonb NOT NULL,
    exit_reason text,
    direction text,
    entry_group text,
    sizing jsonb,
    atr_stop jsonb,
    expected_move jsonb,
    CONSTRAINT backtest_trade_direction CHECK (((direction IS NULL) OR (direction = ANY (ARRAY['long'::text, 'short'::text])))),
    CONSTRAINT backtest_trade_exit_reason CHECK (((exit_reason IS NULL) OR (exit_reason = ANY (ARRAY['condition'::text, 'time_stop'::text, 'rebalance'::text, 'atr_stop'::text, 'expected_move'::text, 'trailing_stop'::text, 'session_end'::text, 'strategy_trailing_stop'::text])))),
    CONSTRAINT backtest_trade_status CHECK ((status = ANY (ARRAY['closed'::text, 'open'::text, 'aborted'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY backtest_trade FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE factor_coverage (
    factor text NOT NULL,
    as_of date NOT NULL,
    known integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE factor_snapshot (
    as_of date NOT NULL,
    instrument_id uuid NOT NULL,
    "values" jsonb NOT NULL,
    close_ret double precision,
    high_rel double precision,
    low_rel double precision,
    catalogue_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE ml_evaluation (
    model_run_id uuid NOT NULL,
    as_of date NOT NULL,
    ic double precision,
    universe_size integer NOT NULL,
    predicted integer NOT NULL,
    labelled integer NOT NULL,
    decile_spread double precision,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE ml_feature_snapshot (
    model_id uuid NOT NULL,
    instrument_id uuid NOT NULL,
    as_of date NOT NULL,
    features jsonb NOT NULL,
    raw jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE ml_label (
    model_id uuid NOT NULL,
    instrument_id uuid NOT NULL,
    as_of date NOT NULL,
    label_end date NOT NULL,
    forward_return double precision NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ml_label_window CHECK ((label_end > as_of))
);
--> statement-breakpoint
CREATE TABLE ml_report (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    model_id uuid NOT NULL,
    markdown text NOT NULL,
    summary jsonb NOT NULL,
    code_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE option_chain_snapshot (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    underlying_id uuid NOT NULL,
    as_of_date date NOT NULL,
    underlying_close numeric,
    bid numeric,
    ask numeric,
    last numeric,
    volume integer,
    open_interest integer,
    iv numeric,
    delta numeric,
    gamma numeric,
    vega numeric,
    theta numeric,
    rho numeric,
    theo numeric,
    iv_calc numeric,
    delta_calc numeric,
    gamma_calc numeric,
    source text NOT NULL,
    feed text NOT NULL,
    file_timestamp timestamp with time zone NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    data_version text NOT NULL,
    CONSTRAINT option_chain_snapshot_feed CHECK ((feed = ANY (ARRAY['cboe'::text, 'opra'::text])))
);
--> statement-breakpoint
CREATE TABLE option_contract (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    underlying_id uuid NOT NULL,
    expiry date NOT NULL,
    strike numeric NOT NULL,
    "right" option_right NOT NULL,
    occ_symbol text,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT option_contract_strike_positive CHECK ((strike > (0)::numeric))
);
--> statement-breakpoint
CREATE TABLE pattern (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    user_id uuid NOT NULL,
    rank integer NOT NULL,
    rule jsonb NOT NULL,
    stats jsonb NOT NULL,
    status text NOT NULL,
    decay_state text,
    decay_stats jsonb,
    last_scored date,
    promoted_theory_id uuid,
    promoted_status text,
    promoted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pattern_decay_state CHECK (((decay_state IS NULL) OR (decay_state = ANY (ARRAY['holding'::text, 'weakening'::text, 'broken'::text])))),
    CONSTRAINT pattern_status CHECK ((status = ANY (ARRAY['candidate'::text, 'verified'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY pattern FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE pattern_occurrence (
    pattern_id uuid NOT NULL,
    user_id uuid NOT NULL,
    instrument_id uuid NOT NULL,
    as_of date NOT NULL,
    "window" text NOT NULL,
    hit boolean NOT NULL,
    max_runup double precision NOT NULL,
    max_drawdown double precision NOT NULL,
    forward_return double precision NOT NULL,
    CONSTRAINT pattern_occurrence_window CHECK (("window" = ANY (ARRAY['discovery'::text, 'holdout'::text, 'fresh'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY pattern_occurrence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE pattern_scan (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    config jsonb NOT NULL,
    summary text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    candidates_tested integer,
    finalists integer,
    verified integer,
    effective jsonb,
    error text,
    code_version text,
    seconds double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT pattern_scan_status CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text])))
);
--> statement-breakpoint
ALTER TABLE ONLY pattern_scan FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ONLY backtest_trade
    ADD CONSTRAINT backtest_trade_cycle_uq UNIQUE (run_id, cycle);
--> statement-breakpoint
ALTER TABLE ONLY backtest_trade
    ADD CONSTRAINT backtest_trade_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY factor_coverage
    ADD CONSTRAINT factor_coverage_factor_as_of_pk PRIMARY KEY (factor, as_of);
--> statement-breakpoint
ALTER TABLE ONLY factor_snapshot
    ADD CONSTRAINT factor_snapshot_as_of_instrument_id_pk PRIMARY KEY (as_of, instrument_id);
--> statement-breakpoint
ALTER TABLE ONLY ml_evaluation
    ADD CONSTRAINT ml_evaluation_model_run_id_as_of_pk PRIMARY KEY (model_run_id, as_of);
--> statement-breakpoint
ALTER TABLE ONLY ml_feature_snapshot
    ADD CONSTRAINT ml_feature_snapshot_model_id_instrument_id_as_of_pk PRIMARY KEY (model_id, instrument_id, as_of);
--> statement-breakpoint
ALTER TABLE ONLY ml_label
    ADD CONSTRAINT ml_label_model_id_instrument_id_as_of_pk PRIMARY KEY (model_id, instrument_id, as_of);
--> statement-breakpoint
ALTER TABLE ONLY ml_report
    ADD CONSTRAINT ml_report_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY option_chain_snapshot
    ADD CONSTRAINT option_chain_snapshot_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY option_chain_snapshot
    ADD CONSTRAINT option_chain_snapshot_uq UNIQUE (contract_id, as_of_date);
--> statement-breakpoint
ALTER TABLE ONLY option_contract
    ADD CONSTRAINT option_contract_occ_uq UNIQUE (occ_symbol);
--> statement-breakpoint
ALTER TABLE ONLY option_contract
    ADD CONSTRAINT option_contract_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY option_contract
    ADD CONSTRAINT option_contract_uq UNIQUE (underlying_id, expiry, strike, "right");
--> statement-breakpoint
ALTER TABLE ONLY pattern_occurrence
    ADD CONSTRAINT pattern_occurrence_pattern_id_instrument_id_as_of_pk PRIMARY KEY (pattern_id, instrument_id, as_of);
--> statement-breakpoint
ALTER TABLE ONLY pattern
    ADD CONSTRAINT pattern_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY pattern_scan
    ADD CONSTRAINT pattern_scan_pkey PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX factor_snapshot_instrument_idx ON factor_snapshot USING btree (instrument_id, as_of);
--> statement-breakpoint
CREATE INDEX option_chain_snapshot_day_idx ON option_chain_snapshot USING btree (underlying_id, as_of_date);
--> statement-breakpoint
CREATE INDEX pattern_scan_idx ON pattern USING btree (scan_id, rank);
--> statement-breakpoint
CREATE INDEX pattern_scan_user_idx ON pattern_scan USING btree (user_id, created_at);
--> statement-breakpoint
CREATE INDEX pattern_user_idx ON pattern USING btree (user_id);
--> statement-breakpoint
ALTER TABLE ONLY option_chain_snapshot
    ADD CONSTRAINT option_chain_snapshot_contract_id_option_contract_id_fk FOREIGN KEY (contract_id) REFERENCES option_contract(id);
--> statement-breakpoint
ALTER TABLE ONLY pattern_occurrence
    ADD CONSTRAINT pattern_occurrence_pattern_id_pattern_id_fk FOREIGN KEY (pattern_id) REFERENCES pattern(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY pattern
    ADD CONSTRAINT pattern_scan_id_pattern_scan_id_fk FOREIGN KEY (scan_id) REFERENCES pattern_scan(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE backtest_trade ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY batch_service ON pattern TO tm_secrets USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY batch_service ON pattern_occurrence TO tm_secrets USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY batch_service ON pattern_scan TO tm_secrets USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE option_chain_snapshot ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE option_contract ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pattern ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pattern_occurrence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pattern_scan ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backtest_trade TO tm_app USING ((user_id = app_current_user_id())) WITH CHECK ((user_id = app_current_user_id()));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON pattern TO tm_app USING ((user_id = app_current_user_id())) WITH CHECK ((user_id = app_current_user_id()));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON pattern_occurrence TO tm_app USING ((user_id = app_current_user_id()));
--> statement-breakpoint
CREATE POLICY tenant_isolation ON pattern_scan TO tm_app USING ((user_id = app_current_user_id())) WITH CHECK ((user_id = app_current_user_id()));
--> statement-breakpoint
CREATE POLICY worker_only ON option_chain_snapshot TO tm_secrets USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY worker_only ON option_contract TO tm_secrets USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON TABLE backtest_trade TO tm_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE factor_coverage TO tm_secrets;
--> statement-breakpoint
GRANT SELECT ON TABLE factor_coverage TO tm_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE factor_snapshot TO tm_secrets;
--> statement-breakpoint
GRANT SELECT ON TABLE factor_snapshot TO tm_app;
--> statement-breakpoint
GRANT UPDATE("values") ON TABLE factor_snapshot TO tm_secrets;
--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE ml_evaluation TO tm_secrets;
--> statement-breakpoint
GRANT SELECT ON TABLE ml_evaluation TO tm_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ml_feature_snapshot TO tm_secrets;
--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE ml_label TO tm_secrets;
--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE ml_report TO tm_secrets;
--> statement-breakpoint
GRANT SELECT ON TABLE ml_report TO tm_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE option_chain_snapshot TO tm_secrets;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE option_contract TO tm_secrets;
--> statement-breakpoint
GRANT SELECT,UPDATE ON TABLE pattern TO tm_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE pattern TO tm_secrets;
--> statement-breakpoint
GRANT SELECT ON TABLE pattern_occurrence TO tm_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE pattern_occurrence TO tm_secrets;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON TABLE pattern_scan TO tm_app;
--> statement-breakpoint
GRANT SELECT,UPDATE ON TABLE pattern_scan TO tm_secrets;
--> statement-breakpoint
-- Dates whose ML predictions exist in Core: snapshots for them are frozen
-- (ML brief v1 §6). Core can't be read from here, so the trainer records each
-- predicted date in this table when it writes the predictions (ADR 0115).
CREATE TABLE ml_frozen_as_of (
  model_id uuid NOT NULL,
  as_of date NOT NULL,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ml_frozen_as_of_pkey PRIMARY KEY (model_id, as_of)
);
--> statement-breakpoint
GRANT SELECT, INSERT ON ml_frozen_as_of TO tm_secrets;
--> statement-breakpoint
CREATE FUNCTION ml_research_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER ml_label_immutable BEFORE UPDATE OR DELETE ON ml_label
  FOR EACH ROW EXECUTE FUNCTION ml_research_immutable();
--> statement-breakpoint
CREATE TRIGGER ml_evaluation_immutable BEFORE UPDATE OR DELETE ON ml_evaluation
  FOR EACH ROW EXECUTE FUNCTION ml_research_immutable();
--> statement-breakpoint
CREATE TRIGGER ml_frozen_as_of_immutable BEFORE UPDATE OR DELETE ON ml_frozen_as_of
  FOR EACH ROW EXECUTE FUNCTION ml_research_immutable();
--> statement-breakpoint
CREATE FUNCTION ml_feature_snapshot_frozen() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ml_frozen_as_of f WHERE f.model_id = OLD.model_id AND f.as_of = OLD.as_of
  ) THEN
    RAISE EXCEPTION 'snapshots for % are frozen: predictions exist for that date', OLD.as_of
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER ml_feature_snapshot_frozen BEFORE UPDATE OR DELETE ON ml_feature_snapshot
  FOR EACH ROW EXECUTE FUNCTION ml_feature_snapshot_frozen();
--> statement-breakpoint
-- A pattern's rule, stats and occurrences are the scan's evidence: written
-- once. The app may only record a promotion; decay may only update its state.
CREATE FUNCTION pattern_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rule IS DISTINCT FROM OLD.rule OR NEW.stats IS DISTINCT FROM OLD.stats
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.scan_id IS DISTINCT FROM OLD.scan_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.rank IS DISTINCT FROM OLD.rank THEN
    RAISE EXCEPTION 'a pattern''s rule and evidence are never rewritten'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER pattern_guard BEFORE UPDATE ON pattern
  FOR EACH ROW EXECUTE FUNCTION pattern_guard();
--> statement-breakpoint
-- Account purge (ADR 0042): Core's purge_deleted_accounts removes Core rows;
-- the worker then calls this with the purged ids. Only tm_secrets may call it.
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
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_research_users(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_research_users(uuid[]) TO tm_secrets;
--> statement-breakpoint
-- Research Store integrity sweep (ADR 0115): the owners and back test runs
-- research rows belong to, so the worker can drop those Core no longer has.
CREATE FUNCTION research_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT user_id FROM backtest_trade UNION SELECT user_id FROM pattern_scan
  UNION SELECT user_id FROM pattern UNION SELECT user_id FROM pattern_occurrence
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION research_user_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION research_user_ids() TO tm_secrets;
--> statement-breakpoint
CREATE FUNCTION research_trade_run_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT run_id FROM backtest_trade
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION research_trade_run_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION research_trade_run_ids() TO tm_secrets;
--> statement-breakpoint
CREATE FUNCTION delete_research_trades(p_run_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM backtest_trade WHERE run_id = ANY (p_run_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION delete_research_trades(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delete_research_trades(uuid[]) TO tm_secrets;
--> statement-breakpoint
-- Database size for the storage alert, readable by the worker's batch role.
CREATE FUNCTION storage_bytes() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pg_database_size(current_database())
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION storage_bytes() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION storage_bytes() TO tm_secrets;
