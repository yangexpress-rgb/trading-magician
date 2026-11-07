ALTER TABLE "backtest_trade" DROP CONSTRAINT "backtest_trade_exit_reason";--> statement-breakpoint
ALTER TABLE "backtest_trade" ADD COLUMN "sizing" jsonb;--> statement-breakpoint
ALTER TABLE "backtest_trade" ADD COLUMN "atr_stop" jsonb;--> statement-breakpoint
ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_exit_reason" CHECK ("backtest_trade"."exit_reason" is null or "backtest_trade"."exit_reason" in ('condition', 'time_stop', 'rebalance', 'atr_stop'));