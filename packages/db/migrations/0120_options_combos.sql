CREATE TABLE "option_dividend" (
	"underlying_id" uuid NOT NULL,
	"ex_date" date NOT NULL,
	"cash_amount" numeric NOT NULL,
	"fetched_on" date NOT NULL,
	CONSTRAINT "option_dividend_underlying_id_ex_date_pk" PRIMARY KEY("underlying_id","ex_date")
);
--> statement-breakpoint
ALTER TABLE "backtest_trade" DROP CONSTRAINT "backtest_trade_exit_reason";--> statement-breakpoint
ALTER TABLE "fill" DROP CONSTRAINT "fill_price_positive";--> statement-breakpoint
ALTER TABLE "fill" DROP CONSTRAINT "fill_kind";--> statement-breakpoint
ALTER TABLE "order_intent" ADD COLUMN "order_group_id" text;--> statement-breakpoint
ALTER TABLE "option_dividend" ADD CONSTRAINT "option_dividend_underlying_id_instrument_id_fk" FOREIGN KEY ("underlying_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_intent_group_idx" ON "order_intent" USING btree ("order_group_id") WHERE "order_intent"."order_group_id" is not null;--> statement-breakpoint
ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_exit_reason" CHECK ("backtest_trade"."exit_reason" is null or "backtest_trade"."exit_reason" in ('condition', 'time_stop', 'rebalance', 'atr_stop', 'expected_move', 'trailing_stop', 'session_end', 'strategy_trailing_stop', 'option_target', 'option_dte', 'expired_worthless', 'exercised', 'assigned', 'closed_before_expiry', 'dividend_risk'));--> statement-breakpoint
ALTER TABLE "fill" ADD CONSTRAINT "fill_price_positive" CHECK ("fill"."price" > 0 or ("fill"."kind" in ('expiry', 'assignment', 'exercise') and "fill"."price" = 0));--> statement-breakpoint
ALTER TABLE "fill" ADD CONSTRAINT "fill_kind" CHECK ("fill"."kind" in ('trade', 'expiry', 'assignment', 'exercise'));--> statement-breakpoint
-- Options brief v0.2 §7.5 (ADR 0123, Phase O2): the ex-dividend calendar is written and read by the worker only.
GRANT SELECT, INSERT, UPDATE, DELETE ON "option_dividend" TO tm_secrets;
