CREATE TYPE "public"."feed_entitlement" AS ENUM('unknown', 'entitled', 'not_entitled');--> statement-breakpoint
CREATE TYPE "public"."route_source" AS ENUM('primary', 'fallback');--> statement-breakpoint
ALTER TABLE "data_feed_connection" ADD COLUMN "entitlement" "feed_entitlement" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_feed_connection" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_feed_connection" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "data_feed_connection" ADD COLUMN "check_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_feed_connection" ADD COLUMN "check_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_route" ADD COLUMN "active_source" "route_source" DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_route" ADD COLUMN "switched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_route" ADD COLUMN "primary_ok_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_route" ADD CONSTRAINT "data_route_fallback_present" CHECK ("data_route"."active_source" = 'primary' OR "data_route"."fallback_feed_id" IS NOT NULL);