CREATE TYPE "public"."company_report_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "company_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"status" "company_report_status" DEFAULT 'pending' NOT NULL,
	"report" jsonb,
	"source" text,
	"message" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_report_symbol" CHECK ("company_report"."symbol" ~ '^[A-Z][A-Z0-9.]{0,9}$'),
	CONSTRAINT "company_report_ready_has_report" CHECK (("company_report"."status" = 'ready') = ("company_report"."report" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "company_report" ADD CONSTRAINT "company_report_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_report_pending_idx" ON "company_report" USING btree ("created_at") WHERE "company_report"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "company_report_reuse_idx" ON "company_report" USING btree ("user_id","symbol","created_at");