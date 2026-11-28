-- Each run's starting capital, chosen at Start (N400, ADR 0125). Existing runs keep the former
-- fixed $100,000 through the default; Start always writes the chosen amount.
ALTER TABLE "strategy_runtime" ADD COLUMN "starting_capital" numeric DEFAULT '100000' NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_runtime" ADD CONSTRAINT "strategy_runtime_starting_capital" CHECK ("strategy_runtime"."starting_capital" > 0);