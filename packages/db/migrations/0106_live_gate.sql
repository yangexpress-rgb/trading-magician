-- Phase 7 P3 (N317 to N321, ADR 0109): the live gate. The paper-only checks give way to an
-- environment that flows from the platform to its accounts, runs and orders, checked here so no
-- live order can sit on a paper account or the other way round. Whether live trading may happen
-- at all is the server's LIVE_TRADING_ENABLED flag (off by default); nothing here turns it on.
-- A live platform records the person's real-money acknowledgement; a live account carries its
-- pilot caps and what the broker last reported for pattern-day-trader awareness.
ALTER TABLE "broker_connection" DROP CONSTRAINT "broker_connection_paper_only";--> statement-breakpoint
ALTER TABLE "credential" DROP CONSTRAINT "credential_paper_only";--> statement-breakpoint
ALTER TABLE "order_intent" DROP CONSTRAINT "order_intent_paper_only";--> statement-breakpoint
ALTER TABLE "strategy_runtime" DROP CONSTRAINT "strategy_runtime_paper_only";--> statement-breakpoint
ALTER TABLE "trading_account" DROP CONSTRAINT "trading_account_paper_only";--> statement-breakpoint
ALTER TABLE "broker_connection" ADD COLUMN "real_money_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "pilot_max_order" numeric;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "pilot_max_exposure" numeric;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "pilot_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "broker_day_trades" integer;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "broker_equity" numeric;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "broker_margin" boolean;--> statement-breakpoint
ALTER TABLE "broker_connection" ADD CONSTRAINT "broker_connection_live_acknowledged" CHECK ("broker_connection"."environment" = 'paper' or "broker_connection"."real_money_acknowledged_at" is not null);--> statement-breakpoint
ALTER TABLE "trading_account" ADD CONSTRAINT "trading_account_pilot" CHECK (("trading_account"."pilot_max_order" is null or "trading_account"."pilot_max_order" > 0) and ("trading_account"."pilot_max_exposure" is null or "trading_account"."pilot_max_exposure" > 0));--> statement-breakpoint
CREATE FUNCTION trading_account_environment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  platform_environment trading_mode;
BEGIN
  SELECT environment INTO platform_environment FROM broker_connection WHERE id = NEW.broker_connection_id;
  IF platform_environment IS DISTINCT FROM NEW.mode THEN
    RAISE EXCEPTION 'An account is paper or live as its platform is'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'trading_account_environment';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trading_account_environment BEFORE INSERT OR UPDATE OF mode, broker_connection_id
  ON "trading_account" FOR EACH ROW EXECUTE FUNCTION trading_account_environment();--> statement-breakpoint
CREATE FUNCTION strategy_runtime_environment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_mode trading_mode;
BEGIN
  IF NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT mode INTO account_mode FROM trading_account WHERE id = NEW.account_id;
  IF account_mode IS DISTINCT FROM NEW.mode THEN
    RAISE EXCEPTION 'A run is paper or live as its account is'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'strategy_runtime_environment';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER strategy_runtime_environment BEFORE INSERT OR UPDATE OF mode, account_id
  ON "strategy_runtime" FOR EACH ROW EXECUTE FUNCTION strategy_runtime_environment();--> statement-breakpoint
CREATE FUNCTION order_intent_environment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_mode trading_mode;
BEGIN
  SELECT mode INTO account_mode FROM trading_account WHERE id = NEW.account_id;
  IF account_mode IS DISTINCT FROM NEW.mode THEN
    RAISE EXCEPTION 'An order is paper or live as its account is'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_intent_environment';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER order_intent_environment BEFORE INSERT OR UPDATE OF mode, account_id
  ON "order_intent" FOR EACH ROW EXECUTE FUNCTION order_intent_environment();
