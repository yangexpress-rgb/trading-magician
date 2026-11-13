CREATE TABLE "factor_coverage" (
	"factor" text NOT NULL,
	"as_of" date NOT NULL,
	"known" integer NOT NULL,
	CONSTRAINT "factor_coverage_factor_as_of_pk" PRIMARY KEY("factor","as_of")
);
--> statement-breakpoint
CREATE TABLE "factor_snapshot" (
	"as_of" date NOT NULL,
	"instrument_id" uuid NOT NULL,
	"values" jsonb NOT NULL,
	"close_ret" double precision,
	"high_rel" double precision,
	"low_rel" double precision,
	"catalogue_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factor_snapshot_as_of_instrument_id_pk" PRIMARY KEY("as_of","instrument_id")
);
--> statement-breakpoint
ALTER TABLE "factor_snapshot" ADD CONSTRAINT "factor_snapshot_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "factor_snapshot_instrument_idx" ON "factor_snapshot" USING btree ("instrument_id","as_of");--> statement-breakpoint
-- Pattern discovery's factor store (pattern brief §3, ADR 0091). Public market
-- data kept once for every tenant: only the worker login (tm_secrets) writes
-- it, insert-only, so a snapshot row is never rewritten after the fact. The
-- app login reads it for Research › Patterns (coverage report, event study).
GRANT SELECT, INSERT ON "factor_snapshot" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "factor_snapshot" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "factor_coverage" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "factor_coverage" TO tm_app;
