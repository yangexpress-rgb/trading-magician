-- Every safety close states why (N306, ADR 0105). Earlier safety closes keep no reason
-- (no backfill), so the reason check applies to new rows only (NOT VALID).
ALTER TABLE "execution_incident" DROP CONSTRAINT "execution_incident_kind";--> statement-breakpoint
ALTER TABLE "order_intent" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "execution_incident" ADD CONSTRAINT "execution_incident_kind" CHECK ("execution_incident"."kind" in ('reconciliation_mismatch', 'repeated_rejects', 'stale_data', 'feed_loss', 'broker_disconnected', 'safety_close'));--> statement-breakpoint
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_close_reason" CHECK ("order_intent"."source" <> 'system' or coalesce(char_length(btrim("order_intent"."close_reason")), 0) > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_close_reason_length" CHECK (char_length("order_intent"."close_reason") <= 1000);