-- Phase 7 P0 (N308, N309, ADR 0106): a run is one strategy trading on one account.
-- Every existing run is bound to the account its pinned version's legs name today (the
-- account its orders went to); nothing in any strategy's definition or risk limits changes.
DROP INDEX "strategy_runtime_one_active_idx";--> statement-breakpoint
ALTER TABLE "strategy_runtime" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "strategy_runtime" DISABLE TRIGGER USER;--> statement-breakpoint
-- The pinned version's first Entry leg, else its first Exit leg, else the account the run's
-- own latest order went to, else the person's default account. Only accounts of the same
-- person count, so a stale id in old rules is skipped rather than trusted.
UPDATE "strategy_runtime" r SET "account_id" = pick.account_id
  FROM (
    SELECT r2.id, coalesce(
      (SELECT a.id FROM "trading_account" a
        WHERE a.user_id = r2.user_id
          AND a.id::text = v.definition #>> '{entry,orders,0,accountId}'),
      (SELECT a.id FROM "trading_account" a
        WHERE a.user_id = r2.user_id
          AND a.id::text = v.definition #>> '{exit,orders,0,accountId}'),
      (SELECT oi.account_id FROM "order_intent" oi
        WHERE oi.runtime_id = r2.id ORDER BY oi.created_at DESC LIMIT 1),
      (SELECT a.id FROM "trading_account" a
        WHERE a.user_id = r2.user_id AND a.is_default LIMIT 1)
    ) AS account_id
    FROM "strategy_runtime" r2
    JOIN "strategy_version" v ON v.id = r2.version_id
  ) pick
 WHERE r.id = pick.id;--> statement-breakpoint
ALTER TABLE "strategy_runtime" ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE "strategy_runtime" ADD CONSTRAINT "strategy_runtime_account_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."trading_account"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strategy_runtime_account_idx" ON "strategy_runtime" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_runtime_one_active_idx" ON "strategy_runtime" USING btree ("strategy_id","account_id") WHERE "strategy_runtime"."status" <> 'stopped';--> statement-breakpoint
ALTER TABLE "strategy_runtime" ADD CONSTRAINT "strategy_runtime_account" CHECK ("strategy_runtime"."account_id" is not null or "strategy_runtime"."status" = 'stopped');--> statement-breakpoint
-- A run's account never changes once set: its orders, positions and history belong to it.
CREATE FUNCTION strategy_runtime_account_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'A run''s account cannot change' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'strategy_runtime_account_fixed';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER strategy_runtime_account_fixed BEFORE UPDATE OF account_id ON "strategy_runtime"
  FOR EACH ROW EXECUTE FUNCTION strategy_runtime_account_fixed();--> statement-breakpoint
-- A6: an order can only ever go to its own run's account. Checked for every new order and
-- any change of its run or account; orders recorded before this migration are left as they are.
CREATE FUNCTION order_intent_run_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_account uuid;
BEGIN
  SELECT account_id INTO run_account FROM "strategy_runtime" WHERE id = NEW.runtime_id;
  -- A run this tenant can't see is left to the foreign key, which refuses it.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF run_account IS NULL OR run_account <> NEW.account_id THEN
    RAISE EXCEPTION 'An order can only go to its own run''s account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_intent_run_account';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER order_intent_run_account BEFORE INSERT OR UPDATE OF account_id, runtime_id
  ON "order_intent" FOR EACH ROW EXECUTE FUNCTION order_intent_run_account();
