-- Pre-market and after-hours trades kept apart from the regular session (N296, ADR 0101).
ALTER TABLE "watch_quote" ADD COLUMN "ext_last" double precision;--> statement-breakpoint
ALTER TABLE "watch_quote" ADD COLUMN "ext_at" timestamp with time zone;