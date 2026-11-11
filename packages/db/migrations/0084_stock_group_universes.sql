ALTER TABLE "event_scan_state" DROP CONSTRAINT "event_scan_state_job";--> statement-breakpoint
ALTER TABLE "stock_screen" DROP CONSTRAINT "stock_screen_universe";--> statement-breakpoint
ALTER TABLE "event_scan_state" ADD CONSTRAINT "event_scan_state_job" CHECK ("event_scan_state"."job" in ('earnings_scan', 'earnings_rebuild', 'earnings_backfill', 'deals_scan', 'deals_rebuild', 'calendar', 'deal_closes'));--> statement-breakpoint
ALTER TABLE "stock_screen" ADD CONSTRAINT "stock_screen_universe" CHECK ("stock_screen"."universe" ~ '^[a-z0-9_]{1,40}$');