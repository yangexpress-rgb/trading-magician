CREATE TYPE "public"."subscription_status" AS ENUM('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused');--> statement-breakpoint
CREATE TABLE "billing_event" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"type" text NOT NULL,
	"user_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text,
	"status" "subscription_status",
	"price_id" text,
	"plan_code" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "subscription_subscription_id_unique" UNIQUE("subscription_id"),
	CONSTRAINT "subscription_customer_unique" UNIQUE("provider","customer_id")
);
--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_kind";--> statement-breakpoint
ALTER TABLE "plan" ADD COLUMN "stripe_price_id" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_plan_code_plan_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plan"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_stripe_price_id_unique" UNIQUE("stripe_price_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_kind" CHECK ("notification"."kind" in ('strategy_started', 'strategy_stopped', 'triggered', 'order_rejected', 'partial_fill', 'filled', 'disconnect', 'stale_data', 'risk_pause', 'reconciliation_mismatch', 'billing'));