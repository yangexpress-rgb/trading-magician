CREATE TABLE "deal_event" (
	"deal_id" text PRIMARY KEY NOT NULL,
	"seq" integer NOT NULL,
	"target_symbol" text,
	"target_cik" text,
	"target_name" text NOT NULL,
	"acquirer_name" text,
	"announced_date" date NOT NULL,
	"announced_at" timestamp with time zone NOT NULL,
	"offer_price" numeric,
	"consideration" text NOT NULL,
	"status" text NOT NULL,
	"source_filing_url" text NOT NULL,
	"accession" text NOT NULL,
	"confidence" text NOT NULL,
	"parse_note" text,
	"source" text NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	CONSTRAINT "deal_event_seq_uq" UNIQUE("seq"),
	CONSTRAINT "deal_event_accession_uq" UNIQUE("accession"),
	CONSTRAINT "deal_event_id_format" CHECK ("deal_event"."deal_id" ~ '^D[0-9]{5,}$'),
	CONSTRAINT "deal_event_consideration" CHECK ("deal_event"."consideration" in ('cash', 'stock', 'mixed', 'unknown')),
	CONSTRAINT "deal_event_status" CHECK ("deal_event"."status" in ('announced', 'pending', 'closed', 'withdrawn')),
	CONSTRAINT "deal_event_confidence" CHECK ("deal_event"."confidence" in ('high', 'low')),
	CONSTRAINT "deal_event_source" CHECK ("deal_event"."source" in ('rebuilt', 'recorded')),
	CONSTRAINT "deal_event_offer_positive" CHECK ("deal_event"."offer_price" is null or "deal_event"."offer_price" > 0)
);
--> statement-breakpoint
CREATE TABLE "deal_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"changed_date" date NOT NULL,
	"old_status" text NOT NULL,
	"new_status" text NOT NULL,
	"source_filing_url" text NOT NULL,
	"accession" text NOT NULL,
	CONSTRAINT "deal_status_history_uq" UNIQUE("deal_id","accession")
);
--> statement-breakpoint
CREATE TABLE "earnings_calendar" (
	"symbol" text NOT NULL,
	"scheduled_date" date NOT NULL,
	"provider" text NOT NULL,
	"time_hint" text,
	"estimated_eps" numeric,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "earnings_calendar_pk" PRIMARY KEY("symbol","scheduled_date"),
	CONSTRAINT "earnings_calendar_provider" CHECK ("earnings_calendar"."provider" in ('fmp', 'finnhub'))
);
--> statement-breakpoint
CREATE TABLE "earnings_release" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"cik" text NOT NULL,
	"fiscal_quarter_end" date NOT NULL,
	"announced_at" timestamp with time zone NOT NULL,
	"announced_date" date NOT NULL,
	"time_known" boolean DEFAULT true NOT NULL,
	"reported_eps" numeric,
	"estimated_eps" numeric,
	"estimate_source" text,
	"surprise_pct" numeric,
	"source" text DEFAULT 'edgar' NOT NULL,
	"accession" text NOT NULL,
	"filing_url" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "earnings_release_quarter_uq" UNIQUE("symbol","fiscal_quarter_end"),
	CONSTRAINT "earnings_release_accession_uq" UNIQUE("symbol","accession"),
	CONSTRAINT "earnings_release_source" CHECK ("earnings_release"."source" = 'edgar'),
	CONSTRAINT "earnings_release_estimate_source" CHECK ("earnings_release"."estimate_source" is null or "earnings_release"."estimate_source" in ('fmp', 'finnhub'))
);
--> statement-breakpoint
CREATE TABLE "earnings_sue" (
	"symbol" text NOT NULL,
	"fiscal_quarter_end" date NOT NULL,
	"announced_at" timestamp with time zone NOT NULL,
	"eps_q" numeric NOT NULL,
	"eps_q_minus_4" numeric NOT NULL,
	"diff_sd" numeric,
	"sue" numeric,
	"source" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "earnings_sue_pk" PRIMARY KEY("symbol","fiscal_quarter_end"),
	CONSTRAINT "earnings_sue_source" CHECK ("earnings_sue"."source" in ('rebuilt', 'recorded'))
);
--> statement-breakpoint
CREATE TABLE "event_scan_state" (
	"job" text PRIMARY KEY NOT NULL,
	"covered_from" date,
	"covered_to" date,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"note" text,
	CONSTRAINT "event_scan_state_job" CHECK ("event_scan_state"."job" in ('earnings_scan', 'earnings_rebuild', 'deals_scan', 'deals_rebuild', 'calendar')),
	CONSTRAINT "event_scan_state_status" CHECK ("event_scan_state"."status" in ('pending', 'running', 'done', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "rates_daily" (
	"date" date PRIMARY KEY NOT NULL,
	"tbill_3m" numeric NOT NULL,
	"source" text DEFAULT 'fred' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rates_daily_source" CHECK ("rates_daily"."source" = 'fred')
);
--> statement-breakpoint
ALTER TABLE "deal_status_history" ADD CONSTRAINT "deal_status_history_deal_id_deal_event_deal_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deal_event"("deal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_event_target_idx" ON "deal_event" USING btree ("target_symbol","announced_date");--> statement-breakpoint
CREATE INDEX "deal_status_history_deal_idx" ON "deal_status_history" USING btree ("deal_id","changed_at");--> statement-breakpoint
CREATE INDEX "earnings_release_symbol_idx" ON "earnings_release" USING btree ("symbol","announced_at");--> statement-breakpoint
-- Earnings, deals and rates (free data feeds brief v1, ADR 0058). Public data
-- kept once for every tenant, like the options signals: only the worker
-- (tm_secrets) writes it, and the app login may read it (no tenant column, so
-- no row-level security, as for instruments).
GRANT SELECT, INSERT, UPDATE, DELETE ON "earnings_release" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "earnings_release" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "earnings_sue" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "earnings_sue" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "earnings_calendar" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "earnings_calendar" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "deal_event" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "deal_event" TO tm_app;--> statement-breakpoint
-- The history is append-only: the worker may add rows, never change them.
GRANT SELECT, INSERT ON "deal_status_history" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "deal_status_history" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "rates_daily" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "rates_daily" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "event_scan_state" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "event_scan_state" TO tm_app;
