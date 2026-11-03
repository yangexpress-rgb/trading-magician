CREATE TYPE "public"."price_chart_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "price_chart" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"interval" text NOT NULL,
	"range" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"status" "price_chart_status" DEFAULT 'pending' NOT NULL,
	"bars" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text,
	"message" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_chart_interval" CHECK ("price_chart"."interval" IN ('1h', '1d')),
	CONSTRAINT "price_chart_range" CHECK ("price_chart"."range" IN ('1w', '1m', '3m', '6m', '1y', '5y')),
	CONSTRAINT "price_chart_dates" CHECK ("price_chart"."from_date" <= "price_chart"."to_date"),
	CONSTRAINT "price_chart_ready_has_bars" CHECK (("price_chart"."status" = 'ready') = ("price_chart"."bars" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "price_chart" ADD CONSTRAINT "price_chart_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_chart" ADD CONSTRAINT "price_chart_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_chart_pending_idx" ON "price_chart" USING btree ("created_at") WHERE "price_chart"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "price_chart_reuse_idx" ON "price_chart" USING btree ("user_id","instrument_id","interval","range","created_at");