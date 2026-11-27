CREATE TABLE "option_contract_list" (
	"underlying_id" uuid PRIMARY KEY NOT NULL,
	"fetched_on" date NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"version" text NOT NULL,
	"expiry_to" date NOT NULL,
	"strike_from" numeric NOT NULL,
	"strike_to" numeric NOT NULL,
	"contracts" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backtest_trade" DROP CONSTRAINT "backtest_trade_exit_reason";--> statement-breakpoint
ALTER TABLE "fill" DROP CONSTRAINT "fill_price_positive";--> statement-breakpoint
ALTER TABLE "fill" ADD COLUMN "kind" text DEFAULT 'trade' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_intent" ADD COLUMN "option_detail" jsonb;--> statement-breakpoint
ALTER TABLE "option_contract_list" ADD CONSTRAINT "option_contract_list_underlying_id_instrument_id_fk" FOREIGN KEY ("underlying_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_exit_reason" CHECK ("backtest_trade"."exit_reason" is null or "backtest_trade"."exit_reason" in ('condition', 'time_stop', 'rebalance', 'atr_stop', 'expected_move', 'trailing_stop', 'session_end', 'strategy_trailing_stop', 'option_target', 'option_dte', 'expired_worthless', 'exercised', 'assigned', 'closed_before_expiry'));--> statement-breakpoint
ALTER TABLE "fill" ADD CONSTRAINT "fill_kind" CHECK ("fill"."kind" in ('trade', 'expiry'));--> statement-breakpoint
ALTER TABLE "fill" ADD CONSTRAINT "fill_price_positive" CHECK ("fill"."price" > 0 or ("fill"."kind" = 'expiry' and "fill"."price" = 0));--> statement-breakpoint
-- Options brief v0.2 §6.3 (ADR 0123): the cached contract lists are written and read by the worker only.
GRANT SELECT, INSERT, UPDATE ON "option_contract_list" TO tm_secrets;
