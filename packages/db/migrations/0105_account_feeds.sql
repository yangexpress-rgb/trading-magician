-- Phase 7 P2 (N314 to N316, ADR 0108): each account can have its own data feeds, a primary and
-- ordered fallbacks (account_feed), and a rule for when the feed pricing it stops (fallback or
-- pause; null means the default for its kind). Every order records the feed that priced it.
-- An account without feeds keeps pricing through the data routes, so nothing changes until one
-- is set.
CREATE TABLE "account_feed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"feed_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_feed_feed_uq" UNIQUE("account_id","feed_id"),
	CONSTRAINT "account_feed_position_uq" UNIQUE("account_id","position"),
	CONSTRAINT "account_feed_position" CHECK ("account_feed"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "execution_incident" DROP CONSTRAINT "execution_incident_kind";--> statement-breakpoint
ALTER TABLE "order_intent" ADD COLUMN "priced_by_feed_id" uuid;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "feed_failure" text;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "feed_active_id" uuid;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "feed_primary_ok_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_feed" ADD CONSTRAINT "account_feed_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_feed" ADD CONSTRAINT "account_feed_account_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."trading_account"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_feed" ADD CONSTRAINT "account_feed_feed_fk" FOREIGN KEY ("feed_id","user_id") REFERENCES "public"."data_feed_connection"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_account" ADD CONSTRAINT "trading_account_feed_active_id_data_feed_connection_id_fk" FOREIGN KEY ("feed_active_id") REFERENCES "public"."data_feed_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_incident" ADD CONSTRAINT "execution_incident_kind" CHECK ("execution_incident"."kind" in ('reconciliation_mismatch', 'repeated_rejects', 'stale_data', 'feed_loss', 'broker_disconnected', 'safety_close', 'account_daily_loss', 'account_feed'));--> statement-breakpoint
ALTER TABLE "trading_account" ADD CONSTRAINT "trading_account_feed_failure" CHECK ("trading_account"."feed_failure" is null or "trading_account"."feed_failure" in ('fallback', 'pause'));--> statement-breakpoint
ALTER TABLE "account_feed" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_feed" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "account_feed" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "account_feed" TO tm_app;
