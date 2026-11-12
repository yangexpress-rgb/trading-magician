CREATE TABLE "ml_evaluation" (
	"model_run_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"ic" double precision,
	"universe_size" integer NOT NULL,
	"predicted" integer NOT NULL,
	"labelled" integer NOT NULL,
	"decile_spread" double precision,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ml_evaluation_model_run_id_as_of_pk" PRIMARY KEY("model_run_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "ml_feature_snapshot" (
	"model_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"features" jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ml_feature_snapshot_model_id_instrument_id_as_of_pk" PRIMARY KEY("model_id","instrument_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "ml_label" (
	"model_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"label_end" date NOT NULL,
	"forward_return" double precision NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ml_label_model_id_instrument_id_as_of_pk" PRIMARY KEY("model_id","instrument_id","as_of"),
	CONSTRAINT "ml_label_window" CHECK ("ml_label"."label_end" > "ml_label"."as_of")
);
--> statement-breakpoint
CREATE TABLE "ml_model_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"run_no" integer NOT NULL,
	"prediction_date" date NOT NULL,
	"training_start" date NOT NULL,
	"training_end" date NOT NULL,
	"max_label_end" date NOT NULL,
	"rows_trained" integer NOT NULL,
	"cross_sections" integer NOT NULL,
	"hyperparams" jsonb NOT NULL,
	"coefficients" jsonb NOT NULL,
	"code_version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ml_model_run_no_uq" UNIQUE("model_id","run_no"),
	CONSTRAINT "ml_model_run_status" CHECK ("ml_model_run"."status" in ('active', 'superseded')),
	CONSTRAINT "ml_model_run_embargo" CHECK ("ml_model_run"."max_label_end" < "ml_model_run"."prediction_date"),
	CONSTRAINT "ml_model_run_window" CHECK ("ml_model_run"."training_start" <= "ml_model_run"."training_end")
);
--> statement-breakpoint
CREATE TABLE "ml_model" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_key" text NOT NULL,
	"name" text NOT NULL,
	"theory_number" text,
	"universe" text NOT NULL,
	"feature_set" jsonb NOT NULL,
	"feature_set_version" integer NOT NULL,
	"label" jsonb NOT NULL,
	"algorithm" text NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"snapshots_from" date NOT NULL,
	"availability" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ml_model_model_key_unique" UNIQUE("model_key"),
	CONSTRAINT "ml_model_status" CHECK ("ml_model"."status" in ('registered', 'retired')),
	CONSTRAINT "ml_model_key" CHECK ("ml_model"."model_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "ml_prediction" (
	"model_run_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"score" double precision NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ml_prediction_model_run_id_instrument_id_as_of_pk" PRIMARY KEY("model_run_id","instrument_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "ml_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"markdown" text NOT NULL,
	"summary" jsonb NOT NULL,
	"code_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ml_evaluation" ADD CONSTRAINT "ml_evaluation_model_run_id_ml_model_run_id_fk" FOREIGN KEY ("model_run_id") REFERENCES "public"."ml_model_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_feature_snapshot" ADD CONSTRAINT "ml_feature_snapshot_model_id_ml_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ml_model"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_feature_snapshot" ADD CONSTRAINT "ml_feature_snapshot_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_label" ADD CONSTRAINT "ml_label_model_id_ml_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ml_model"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_label" ADD CONSTRAINT "ml_label_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_model_run" ADD CONSTRAINT "ml_model_run_model_id_ml_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ml_model"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_prediction" ADD CONSTRAINT "ml_prediction_model_run_id_ml_model_run_id_fk" FOREIGN KEY ("model_run_id") REFERENCES "public"."ml_model_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_prediction" ADD CONSTRAINT "ml_prediction_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_report" ADD CONSTRAINT "ml_report_model_id_ml_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ml_model"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ml_model_run_active_uq" ON "ml_model_run" USING btree ("model_id","prediction_date") WHERE "ml_model_run"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ml_prediction_instrument_idx" ON "ml_prediction" USING btree ("instrument_id","as_of");--> statement-breakpoint
-- ML prediction signals (ML brief v1, ADR 0086). Public data kept once for every
-- tenant, like options signals: only the worker login (tm_secrets) writes it,
-- the worker's snapshot job and the trainer service alike. The app login reads
-- the model list for the builder and the scores strategies read. Snapshots and
-- labels are the trainer's inputs, not shown to members.
GRANT SELECT, INSERT, UPDATE ON "ml_model" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "ml_model" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ml_model_run" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "ml_model_run" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ml_feature_snapshot" TO tm_secrets;--> statement-breakpoint
GRANT SELECT, INSERT ON "ml_label" TO tm_secrets;--> statement-breakpoint
GRANT SELECT, INSERT ON "ml_prediction" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "ml_prediction" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "ml_evaluation" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "ml_evaluation" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "ml_report" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "ml_report" TO tm_app;--> statement-breakpoint
-- Predictions are immutable (brief §4): no UPDATE or DELETE path, even for the
-- owner. A generation bug is fixed by superseding the run and writing a new one.
CREATE FUNCTION ml_prediction_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ml_prediction rows are immutable: supersede the model run instead'
    USING ERRCODE = 'insufficient_privilege';
END
$$;--> statement-breakpoint
CREATE TRIGGER ml_prediction_immutable BEFORE UPDATE OR DELETE ON "ml_prediction"
  FOR EACH ROW EXECUTE FUNCTION ml_prediction_immutable();--> statement-breakpoint
CREATE TRIGGER ml_label_immutable BEFORE UPDATE OR DELETE ON "ml_label"
  FOR EACH ROW EXECUTE FUNCTION ml_prediction_immutable();--> statement-breakpoint
CREATE TRIGGER ml_evaluation_immutable BEFORE UPDATE OR DELETE ON "ml_evaluation"
  FOR EACH ROW EXECUTE FUNCTION ml_prediction_immutable();--> statement-breakpoint
-- A model run is written once; the only change is active → superseded.
CREATE FUNCTION ml_model_run_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'model runs are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'superseded'
     AND (to_jsonb(NEW) - 'status' - 'superseded_at') = (to_jsonb(OLD) - 'status' - 'superseded_at') THEN
    NEW.superseded_at := coalesce(NEW.superseded_at, now());
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a model run can only change from active to superseded'
    USING ERRCODE = 'insufficient_privilege';
END
$$;--> statement-breakpoint
CREATE TRIGGER ml_model_run_guard BEFORE UPDATE OR DELETE ON "ml_model_run"
  FOR EACH ROW EXECUTE FUNCTION ml_model_run_guard();--> statement-breakpoint
-- Snapshots for a date freeze once any prediction exists for it (brief §5).
CREATE FUNCTION ml_feature_snapshot_frozen() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ml_prediction p
      JOIN ml_model_run r ON r.id = p.model_run_id
     WHERE r.model_id = OLD.model_id AND p.as_of = OLD.as_of
  ) THEN
    RAISE EXCEPTION 'snapshots for % are frozen: predictions exist for that date', OLD.as_of
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER ml_feature_snapshot_frozen BEFORE UPDATE OR DELETE ON "ml_feature_snapshot"
  FOR EACH ROW EXECUTE FUNCTION ml_feature_snapshot_frozen();--> statement-breakpoint
-- The first model series (brief §1, §6, §7): the S&P 500 multi-factor ranker.
INSERT INTO ml_model (model_key, name, universe, feature_set, feature_set_version, label, algorithm, snapshots_from)
VALUES (
  'mf-ranker-ridge',
  'Multi-factor ranker (ridge)',
  'sp500',
  '["mom_12_1","mom_6_1","mom_3_1","rev_1m","vol_60","rsi_14","dist_high_252","pe","earnings_yield","dividend_yield","sue"]'::jsonb,
  1,
  '{"kind":"forward_return_minus_universe_median","horizonTradingDays":21,"prices":"split_and_dividend adjusted daily closes"}'::jsonb,
  'ridge',
  '2017-01-31'
);
