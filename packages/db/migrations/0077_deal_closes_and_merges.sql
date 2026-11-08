CREATE TABLE "deal_filing" (
	"accession" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"filing_url" text NOT NULL,
	"filed_date" date NOT NULL,
	"merged_from" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_scan_state" DROP CONSTRAINT "event_scan_state_job";--> statement-breakpoint
ALTER TABLE "deal_event" ADD COLUMN "last_close" numeric;--> statement-breakpoint
ALTER TABLE "deal_event" ADD COLUMN "last_close_date" date;--> statement-breakpoint
ALTER TABLE "deal_event" ADD COLUMN "merged_into" text;--> statement-breakpoint
ALTER TABLE "deal_filing" ADD CONSTRAINT "deal_filing_deal_id_deal_event_deal_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deal_event"("deal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_filing_deal_idx" ON "deal_filing" USING btree ("deal_id");--> statement-breakpoint
ALTER TABLE "deal_event" ADD CONSTRAINT "deal_event_close_positive" CHECK ("deal_event"."last_close" is null or "deal_event"."last_close" > 0);--> statement-breakpoint
ALTER TABLE "deal_event" ADD CONSTRAINT "deal_event_not_merged_into_self" CHECK ("deal_event"."merged_into" is null or "deal_event"."merged_into" <> "deal_event"."deal_id");--> statement-breakpoint
ALTER TABLE "event_scan_state" ADD CONSTRAINT "event_scan_state_job" CHECK ("event_scan_state"."job" in ('earnings_scan', 'earnings_rebuild', 'deals_scan', 'deals_rebuild', 'calendar', 'deal_closes'));--> statement-breakpoint
-- Deal filings (N152): public data like deal_event, written by the worker only.
-- A filing is linked once and moved only by a merge, never removed.
GRANT SELECT, INSERT, UPDATE ON "deal_filing" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "deal_filing" TO tm_app;
