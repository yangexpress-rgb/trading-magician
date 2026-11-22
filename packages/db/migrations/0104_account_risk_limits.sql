-- Phase 7 P1 (N311 to N313, ADR 0107): optional account limits (maximum total exposure,
-- daily loss limit) and the account halt (kill switch, or the daily loss limit for one New
-- York day). Existing accounts get no limits, so nothing trades differently until one is set.
ALTER TABLE "execution_incident" DROP CONSTRAINT "execution_incident_kind";--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "max_exposure" numeric;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "daily_loss_limit" numeric;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "halt_kind" text;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "halted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "halt_reason" text;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "halt_date" date;--> statement-breakpoint
ALTER TABLE "execution_incident" ADD CONSTRAINT "execution_incident_kind" CHECK ("execution_incident"."kind" in ('reconciliation_mismatch', 'repeated_rejects', 'stale_data', 'feed_loss', 'broker_disconnected', 'safety_close', 'account_daily_loss'));--> statement-breakpoint
ALTER TABLE "trading_account" ADD CONSTRAINT "trading_account_limits_positive" CHECK (("trading_account"."max_exposure" is null or "trading_account"."max_exposure" > 0) and ("trading_account"."daily_loss_limit" is null or "trading_account"."daily_loss_limit" > 0));--> statement-breakpoint
ALTER TABLE "trading_account" ADD CONSTRAINT "trading_account_halt" CHECK (("trading_account"."halt_kind" is null) = ("trading_account"."halted_at" is null) and ("trading_account"."halt_kind" is null or "trading_account"."halt_kind" in ('kill_switch', 'daily_loss')) and ((coalesce("trading_account"."halt_kind", '') = 'daily_loss') = ("trading_account"."halt_date" is not null)));