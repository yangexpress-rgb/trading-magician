CREATE TYPE "public"."instrument_lookup_status" AS ENUM('pending', 'found', 'not_found', 'failed');--> statement-breakpoint
CREATE TABLE "instrument_lookup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"status" "instrument_lookup_status" DEFAULT 'pending' NOT NULL,
	"instrument_id" uuid,
	"message" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_lookup_symbol" CHECK ("instrument_lookup"."symbol" ~ '^[A-Z][A-Z0-9.]{0,9}$'),
	CONSTRAINT "instrument_lookup_found_has_instrument" CHECK (("instrument_lookup"."status" = 'found') = ("instrument_lookup"."instrument_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "instrument_lookup" ADD CONSTRAINT "instrument_lookup_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_lookup" ADD CONSTRAINT "instrument_lookup_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instrument_lookup_pending_idx" ON "instrument_lookup" USING btree ("created_at") WHERE "instrument_lookup"."status" = 'pending';