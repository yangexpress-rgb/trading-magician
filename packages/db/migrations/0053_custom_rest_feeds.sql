CREATE TYPE "public"."custom_feed_test_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "custom_feed_cache" (
	"user_id" uuid NOT NULL,
	"feed_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"symbol" text NOT NULL,
	"range_from" text DEFAULT '' NOT NULL,
	"range_to" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_feed_cache_kind" CHECK ("custom_feed_cache"."kind" in ('bars', 'quote'))
);
--> statement-breakpoint
CREATE TABLE "custom_feed_test" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"digest" text NOT NULL,
	"credential_ref" uuid,
	"symbol" text NOT NULL,
	"status" "custom_feed_test_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"message" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_feed_test_symbol" CHECK ("custom_feed_test"."symbol" ~ '^[A-Z][A-Z0-9.-]{0,11}$')
);
--> statement-breakpoint
CREATE TABLE "custom_feed_usage" (
	"user_id" uuid NOT NULL,
	"feed_id" uuid NOT NULL,
	"period" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "custom_feed_usage_period" CHECK ("custom_feed_usage"."period" in ('minute', 'day'))
);
--> statement-breakpoint
ALTER TABLE "data_feed_connection" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "custom_feed_cache" ADD CONSTRAINT "custom_feed_cache_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_feed_cache" ADD CONSTRAINT "custom_feed_cache_feed_fk" FOREIGN KEY ("feed_id","user_id") REFERENCES "public"."data_feed_connection"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_feed_test" ADD CONSTRAINT "custom_feed_test_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_feed_test" ADD CONSTRAINT "custom_feed_test_credential_fk" FOREIGN KEY ("credential_ref","user_id") REFERENCES "public"."credential"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_feed_usage" ADD CONSTRAINT "custom_feed_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_feed_usage" ADD CONSTRAINT "custom_feed_usage_feed_fk" FOREIGN KEY ("feed_id","user_id") REFERENCES "public"."data_feed_connection"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_feed_cache_key" ON "custom_feed_cache" USING btree ("feed_id","kind","symbol","range_from","range_to");--> statement-breakpoint
CREATE INDEX "custom_feed_test_pending_idx" ON "custom_feed_test" USING btree ("created_at") WHERE "custom_feed_test"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "custom_feed_usage_key" ON "custom_feed_usage" USING btree ("feed_id","period","window_start");--> statement-breakpoint
ALTER TABLE "data_feed_connection" ADD CONSTRAINT "data_feed_connection_custom_config" CHECK (("data_feed_connection"."provider" = 'custom_rest') = ("data_feed_connection"."config" IS NOT NULL));