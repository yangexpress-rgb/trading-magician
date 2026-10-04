CREATE TYPE "public"."asset_class" AS ENUM('stock', 'etf', 'option', 'future', 'forex', 'crypto');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'system');--> statement-breakpoint
CREATE TYPE "public"."connection_health" AS ENUM('unknown', 'healthy', 'degraded', 'down');--> statement-breakpoint
CREATE TYPE "public"."market_data_type" AS ENUM('quotes', 'trades', 'bars');--> statement-breakpoint
CREATE TYPE "public"."option_right" AS ENUM('call', 'put');--> statement-breakpoint
CREATE TYPE "public"."trading_mode" AS ENUM('paper', 'live');--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid,
	"before_ref" text,
	"after_ref" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broker_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"environment" "trading_mode" DEFAULT 'paper' NOT NULL,
	"credential_ref" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"health" "connection_health" DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "broker_connection_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "broker_connection_paper_only" CHECK ("broker_connection"."environment" = 'paper')
);
--> statement-breakpoint
CREATE TABLE "data_feed_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"credential_ref" text,
	"asset_classes" "asset_class"[] NOT NULL,
	"is_realtime" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"health" "connection_health" DEFAULT 'unknown' NOT NULL,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "data_feed_connection_id_user_uq" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "data_route" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_class" "asset_class" NOT NULL,
	"venue" text,
	"data_type" "market_data_type" NOT NULL,
	"primary_feed_id" uuid NOT NULL,
	"fallback_feed_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "data_route_target_uq" UNIQUE NULLS NOT DISTINCT("user_id","asset_class","venue","data_type"),
	CONSTRAINT "data_route_fallback_differs" CHECK ("data_route"."fallback_feed_id" IS NULL OR "data_route"."fallback_feed_id" <> "data_route"."primary_feed_id")
);
--> statement-breakpoint
CREATE TABLE "entitlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_code" text NOT NULL,
	"limits" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "entitlement_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "instrument" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_class" "asset_class" NOT NULL,
	"symbol" text NOT NULL,
	"venue" text NOT NULL,
	"currency" char(3) NOT NULL,
	"display_name" text NOT NULL,
	"tick_size" numeric NOT NULL,
	"lot_size" numeric DEFAULT '1' NOT NULL,
	"multiplier" numeric DEFAULT '1' NOT NULL,
	"underlying_id" uuid,
	"expiry" date,
	"strike" numeric,
	"option_right" "option_right",
	"future_root" text,
	"contract_month" char(7),
	"provider_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_identity_uq" UNIQUE NULLS NOT DISTINCT("asset_class","symbol","venue","expiry","strike","option_right","contract_month"),
	CONSTRAINT "instrument_tick_positive" CHECK ("instrument"."tick_size" > 0),
	CONSTRAINT "instrument_option_fields" CHECK (("instrument"."asset_class" = 'option') = ("instrument"."expiry" IS NOT NULL AND "instrument"."strike" IS NOT NULL AND "instrument"."option_right" IS NOT NULL AND "instrument"."underlying_id" IS NOT NULL)),
	CONSTRAINT "instrument_future_fields" CHECK ("instrument"."asset_class" <> 'future' OR ("instrument"."future_root" IS NOT NULL AND "instrument"."contract_month" IS NOT NULL AND "instrument"."expiry" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"base_currency" char(3) DEFAULT 'USD' NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"broker_connection_id" uuid NOT NULL,
	"nickname" text NOT NULL,
	"masked_external_id" text NOT NULL,
	"mode" "trading_mode" DEFAULT 'paper' NOT NULL,
	"currency" char(3) NOT NULL,
	"capabilities" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "trading_account_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "trading_account_paper_only" CHECK ("trading_account"."mode" = 'paper')
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "broker_connection" ADD CONSTRAINT "broker_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_feed_connection" ADD CONSTRAINT "data_feed_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_route" ADD CONSTRAINT "data_route_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_route" ADD CONSTRAINT "data_route_primary_feed_id_user_id_data_feed_connection_id_user_id_fk" FOREIGN KEY ("primary_feed_id","user_id") REFERENCES "public"."data_feed_connection"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_route" ADD CONSTRAINT "data_route_fallback_feed_id_user_id_data_feed_connection_id_user_id_fk" FOREIGN KEY ("fallback_feed_id","user_id") REFERENCES "public"."data_feed_connection"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_underlying_id_instrument_id_fk" FOREIGN KEY ("underlying_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_account" ADD CONSTRAINT "trading_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_account" ADD CONSTRAINT "trading_account_broker_connection_id_user_id_broker_connection_id_user_id_fk" FOREIGN KEY ("broker_connection_id","user_id") REFERENCES "public"."broker_connection"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_user_time_idx" ON "audit_event" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trading_account_one_default_idx" ON "trading_account" USING btree ("user_id") WHERE "trading_account"."is_default";