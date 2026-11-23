-- Data inputs part 2, item B (N323, ADR 0111): FINRA consolidated short interest, the published
-- fields per instrument and settlement date, readable from FINRA's publication date
-- (available_date), and the job's record of each settlement it read.
CREATE TABLE "short_interest" (
	"instrument_id" uuid NOT NULL,
	"settlement_date" date NOT NULL,
	"available_date" date NOT NULL,
	"symbol" text NOT NULL,
	"short_shares" numeric NOT NULL,
	"previous_short_shares" numeric,
	"change_shares" numeric,
	"avg_daily_volume" numeric,
	"days_to_cover" numeric,
	"revision_flag" text,
	"source" text DEFAULT 'finra' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "short_interest_pk" PRIMARY KEY("instrument_id","settlement_date"),
	CONSTRAINT "short_interest_source" CHECK ("short_interest"."source" = 'finra'),
	CONSTRAINT "short_interest_available" CHECK ("short_interest"."available_date" > "short_interest"."settlement_date")
);
--> statement-breakpoint
CREATE TABLE "short_interest_settlement" (
	"settlement_date" date PRIMARY KEY NOT NULL,
	"available_date" date NOT NULL,
	"published" integer NOT NULL,
	"stored" integer NOT NULL,
	"unresolved" integer NOT NULL,
	"unresolved_symbols" text[] NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "short_interest" ADD CONSTRAINT "short_interest_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "short_interest_settlement_idx" ON "short_interest" USING btree ("settlement_date");--> statement-breakpoint
-- Public market data kept once for every tenant, like rates and earnings: only the worker
-- (tm_secrets) writes it; the app login may read it (no tenant column, no row-level security).
GRANT SELECT, INSERT, UPDATE ON "short_interest" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "short_interest" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "short_interest_settlement" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "short_interest_settlement" TO tm_app;
