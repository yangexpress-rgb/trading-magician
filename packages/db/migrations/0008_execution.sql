CREATE TYPE "public"."cycle_status" AS ENUM('entry_working', 'open', 'exit_working', 'closed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."order_state" AS ENUM('planned', 'scheduled', 'pending_risk', 'ready', 'submitted', 'acknowledged', 'partially_filled', 'filled', 'canceled', 'rejected', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."runtime_status" AS ENUM('running', 'paused', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."scheduled_action_status" AS ENUM('pending', 'done', 'canceled');--> statement-breakpoint
CREATE TABLE "broker_order" (
	"intent_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"state" "order_state" NOT NULL,
	"broker_order_id" text,
	"raw_status" text,
	"filled_quantity" numeric DEFAULT '0' NOT NULL,
	"average_price" numeric,
	"fees" numeric DEFAULT '0' NOT NULL,
	"overfilled" boolean DEFAULT false NOT NULL,
	"reason" text,
	"cancel_requested_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"filled_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "broker_order_filled_nonnegative" CHECK ("broker_order"."filled_quantity" >= 0),
	CONSTRAINT "broker_order_reason_length" CHECK (char_length("broker_order"."reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE "fill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"broker_fill_id" text NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric NOT NULL,
	"fee" numeric DEFAULT '0' NOT NULL,
	"filled_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fill_broker_uq" UNIQUE("intent_id","broker_fill_id"),
	CONSTRAINT "fill_quantity_positive" CHECK ("fill"."quantity" > 0),
	CONSTRAINT "fill_price_positive" CHECK ("fill"."price" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "order_event_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"from_state" "order_state",
	"to_state" "order_state",
	"broker_event_id" text,
	"payload" jsonb NOT NULL,
	"provider_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_event_broker_uq" UNIQUE("intent_id","broker_event_id"),
	CONSTRAINT "order_event_source" CHECK ("order_event"."source" in ('app', 'broker', 'user', 'reconciliation'))
);
--> statement-breakpoint
CREATE TABLE "order_intent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"runtime_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"planned_order_id" text,
	"leg_label" text NOT NULL,
	"trigger_event_id" uuid,
	"scheduled_action_id" uuid,
	"eligible_at" timestamp with time zone NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"side" text NOT NULL,
	"direction" text NOT NULL,
	"quantity" numeric NOT NULL,
	"order_type" text NOT NULL,
	"limit_price" numeric,
	"stop_price" numeric,
	"time_in_force" text NOT NULL,
	"extended_hours" boolean DEFAULT false NOT NULL,
	"reference_price" numeric NOT NULL,
	"risk" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"source" text DEFAULT 'strategy' NOT NULL,
	"mode" "trading_mode" DEFAULT 'paper' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_intent_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "order_intent_idempotency_uq" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "order_intent_paper_only" CHECK ("order_intent"."mode" = 'paper'),
	CONSTRAINT "order_intent_quantity_positive" CHECK ("order_intent"."quantity" > 0),
	CONSTRAINT "order_intent_phase" CHECK ("order_intent"."phase" in ('entry', 'exit', 'flatten')),
	CONSTRAINT "order_intent_direction" CHECK ("order_intent"."direction" in ('buy', 'sell')),
	CONSTRAINT "order_intent_side" CHECK ("order_intent"."side" in ('buy', 'sell', 'sell_short', 'buy_to_cover', 'close', 'reduce')),
	CONSTRAINT "order_intent_order_type" CHECK ("order_intent"."order_type" in ('market', 'limit', 'stop', 'stop_limit')),
	CONSTRAINT "order_intent_tif" CHECK ("order_intent"."time_in_force" in ('day', 'gtc', 'ioc', 'fok')),
	CONSTRAINT "order_intent_source" CHECK ("order_intent"."source" in ('strategy', 'user', 'system'))
);
--> statement-breakpoint
CREATE TABLE "position_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"quantity" numeric NOT NULL,
	"average_cost" numeric,
	"source" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_snapshot_source" CHECK ("position_snapshot"."source" in ('app', 'broker'))
);
--> statement-breakpoint
CREATE TABLE "scheduled_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"runtime_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"phase" text NOT NULL,
	"leg_id" text,
	"due_at" timestamp with time zone NOT NULL,
	"reference_kind" text,
	"reference_id" uuid,
	"dedupe_key" text NOT NULL,
	"status" "scheduled_action_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_action_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "scheduled_action_dedupe_uq" UNIQUE("user_id","dedupe_key"),
	CONSTRAINT "scheduled_action_kind" CHECK ("scheduled_action"."kind" in ('submit_leg', 'leg_timeout', 'expire_order')),
	CONSTRAINT "scheduled_action_phase" CHECK ("scheduled_action"."phase" in ('entry', 'exit', 'flatten')),
	CONSTRAINT "scheduled_action_done" CHECK (("scheduled_action"."status" = 'pending') = ("scheduled_action"."done_at" is null))
);
--> statement-breakpoint
CREATE TABLE "strategy_cycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"runtime_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"status" "cycle_status" DEFAULT 'entry_working' NOT NULL,
	"entry_trigger_event_id" uuid,
	"exit_trigger_event_id" uuid,
	"entry_triggered_at" timestamp with time zone NOT NULL,
	"position_opened_at" timestamp with time zone,
	"exit_triggered_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"realized_pnl" numeric,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "strategy_cycle_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "strategy_cycle_seq_uq" UNIQUE("runtime_id","seq"),
	CONSTRAINT "strategy_cycle_seq_positive" CHECK ("strategy_cycle"."seq" > 0),
	CONSTRAINT "strategy_cycle_closed" CHECK (("strategy_cycle"."status" in ('closed', 'aborted')) = ("strategy_cycle"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "strategy_runtime" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"mode" "trading_mode" DEFAULT 'paper' NOT NULL,
	"status" "runtime_status" DEFAULT 'running' NOT NULL,
	"pause_reason" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_by" uuid,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "strategy_runtime_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "strategy_runtime_paper_only" CHECK ("strategy_runtime"."mode" = 'paper'),
	CONSTRAINT "strategy_runtime_stopped" CHECK (("strategy_runtime"."status" = 'stopped') = ("strategy_runtime"."stopped_at" is not null)),
	CONSTRAINT "strategy_runtime_pause_reason_length" CHECK (char_length("strategy_runtime"."pause_reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE "trigger_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"runtime_id" uuid NOT NULL,
	"cycle_id" uuid,
	"phase" "strategy_phase" NOT NULL,
	"data_time" timestamp with time zone NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" text NOT NULL,
	"qualified" boolean NOT NULL,
	"values" jsonb NOT NULL,
	CONSTRAINT "trigger_event_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "trigger_event_result" CHECK ("trigger_event"."result" in ('true', 'false', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "broker_order" ADD CONSTRAINT "broker_order_intent_id_user_id_order_intent_id_user_id_fk" FOREIGN KEY ("intent_id","user_id") REFERENCES "public"."order_intent"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fill" ADD CONSTRAINT "fill_intent_id_user_id_order_intent_id_user_id_fk" FOREIGN KEY ("intent_id","user_id") REFERENCES "public"."order_intent"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_intent_id_user_id_order_intent_id_user_id_fk" FOREIGN KEY ("intent_id","user_id") REFERENCES "public"."order_intent"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_runtime_id_user_id_strategy_runtime_id_user_id_fk" FOREIGN KEY ("runtime_id","user_id") REFERENCES "public"."strategy_runtime"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_cycle_id_user_id_strategy_cycle_id_user_id_fk" FOREIGN KEY ("cycle_id","user_id") REFERENCES "public"."strategy_cycle"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_version_id_user_id_strategy_version_id_user_id_fk" FOREIGN KEY ("version_id","user_id") REFERENCES "public"."strategy_version"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_account_id_user_id_trading_account_id_user_id_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."trading_account"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_intent" ADD CONSTRAINT "order_intent_trigger_event_id_user_id_trigger_event_id_user_id_fk" FOREIGN KEY ("trigger_event_id","user_id") REFERENCES "public"."trigger_event"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_snapshot" ADD CONSTRAINT "position_snapshot_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_snapshot" ADD CONSTRAINT "position_snapshot_account_id_user_id_trading_account_id_user_id_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."trading_account"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_action" ADD CONSTRAINT "scheduled_action_cycle_id_user_id_strategy_cycle_id_user_id_fk" FOREIGN KEY ("cycle_id","user_id") REFERENCES "public"."strategy_cycle"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_action" ADD CONSTRAINT "scheduled_action_runtime_id_user_id_strategy_runtime_id_user_id_fk" FOREIGN KEY ("runtime_id","user_id") REFERENCES "public"."strategy_runtime"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_cycle" ADD CONSTRAINT "strategy_cycle_runtime_id_user_id_strategy_runtime_id_user_id_fk" FOREIGN KEY ("runtime_id","user_id") REFERENCES "public"."strategy_runtime"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_runtime" ADD CONSTRAINT "strategy_runtime_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_runtime" ADD CONSTRAINT "strategy_runtime_strategy_id_user_id_strategy_id_user_id_fk" FOREIGN KEY ("strategy_id","user_id") REFERENCES "public"."strategy"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_runtime" ADD CONSTRAINT "strategy_runtime_version_id_user_id_strategy_version_id_user_id_fk" FOREIGN KEY ("version_id","user_id") REFERENCES "public"."strategy_version"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_event" ADD CONSTRAINT "trigger_event_runtime_id_user_id_strategy_runtime_id_user_id_fk" FOREIGN KEY ("runtime_id","user_id") REFERENCES "public"."strategy_runtime"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_event" ADD CONSTRAINT "trigger_event_cycle_id_user_id_strategy_cycle_id_user_id_fk" FOREIGN KEY ("cycle_id","user_id") REFERENCES "public"."strategy_cycle"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broker_order_state_idx" ON "broker_order" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "fill_user_time_idx" ON "fill" USING btree ("user_id","filled_at");--> statement-breakpoint
CREATE INDEX "order_event_intent_idx" ON "order_event" USING btree ("intent_id","seq");--> statement-breakpoint
CREATE INDEX "order_intent_cycle_idx" ON "order_intent" USING btree ("cycle_id","created_at");--> statement-breakpoint
CREATE INDEX "order_intent_user_created_idx" ON "order_intent" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "position_snapshot_lookup_idx" ON "position_snapshot" USING btree ("account_id","instrument_id","as_of");--> statement-breakpoint
CREATE INDEX "scheduled_action_due_idx" ON "scheduled_action" USING btree ("due_at") WHERE "scheduled_action"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_runtime_one_active_idx" ON "strategy_runtime" USING btree ("strategy_id") WHERE "strategy_runtime"."status" <> 'stopped';--> statement-breakpoint
CREATE INDEX "strategy_runtime_lease_idx" ON "strategy_runtime" USING btree ("lease_expires_at") WHERE "strategy_runtime"."status" = 'running';--> statement-breakpoint
CREATE INDEX "trigger_event_runtime_idx" ON "trigger_event" USING btree ("runtime_id","evaluated_at");