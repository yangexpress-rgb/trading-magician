CREATE TYPE "public"."backtest_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "backtest_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"definition_hash" text NOT NULL,
	"status" "backtest_run_status" DEFAULT 'queued' NOT NULL,
	"inputs" jsonb NOT NULL,
	"data_source" text NOT NULL,
	"engine_version" text,
	"data_versions" text[] DEFAULT '{}'::text[] NOT NULL,
	"summary" jsonb,
	"result" jsonb,
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backtest_run_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "backtest_run_finished" CHECK (("backtest_run"."status" in ('completed', 'failed', 'canceled')) = ("backtest_run"."finished_at" is not null)),
	CONSTRAINT "backtest_run_error_length" CHECK (char_length("backtest_run"."error") <= 500)
);
--> statement-breakpoint
CREATE TABLE "backtest_trade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"cycle" integer NOT NULL,
	"status" text NOT NULL,
	"entry_time" timestamp with time zone,
	"exit_time" timestamp with time zone,
	"gross_pnl" numeric NOT NULL,
	"costs" numeric NOT NULL,
	"net_pnl" numeric NOT NULL,
	"return_pct" numeric,
	"legs" jsonb NOT NULL,
	CONSTRAINT "backtest_trade_cycle_uq" UNIQUE("run_id","cycle"),
	CONSTRAINT "backtest_trade_status" CHECK ("backtest_trade"."status" in ('closed', 'open', 'aborted'))
);
--> statement-breakpoint
ALTER TABLE "backtest_run" ADD CONSTRAINT "backtest_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_run" ADD CONSTRAINT "backtest_run_strategy_id_user_id_strategy_id_user_id_fk" FOREIGN KEY ("strategy_id","user_id") REFERENCES "public"."strategy"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_run" ADD CONSTRAINT "backtest_run_version_id_user_id_strategy_version_id_user_id_fk" FOREIGN KEY ("version_id","user_id") REFERENCES "public"."strategy_version"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_run_id_user_id_backtest_run_id_user_id_fk" FOREIGN KEY ("run_id","user_id") REFERENCES "public"."backtest_run"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backtest_run_strategy_idx" ON "backtest_run" USING btree ("strategy_id","created_at");--> statement-breakpoint
CREATE INDEX "backtest_run_queue_idx" ON "backtest_run" USING btree ("created_at") WHERE "backtest_run"."status" in ('queued', 'running');