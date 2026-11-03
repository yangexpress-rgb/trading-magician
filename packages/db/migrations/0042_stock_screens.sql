CREATE TYPE "public"."stock_screen_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "stock_screen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "stock_screen_status" DEFAULT 'pending' NOT NULL,
	"session_date" date,
	"rows" jsonb,
	"row_count" integer,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text,
	"message" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_screen_ready_has_rows" CHECK (("stock_screen"."status" = 'ready') = ("stock_screen"."rows" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "stock_screen" ADD CONSTRAINT "stock_screen_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_screen_pending_idx" ON "stock_screen" USING btree ("created_at") WHERE "stock_screen"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "stock_screen_reuse_idx" ON "stock_screen" USING btree ("user_id","created_at");