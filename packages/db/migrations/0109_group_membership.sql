-- Data inputs part 2, item C (N324, ADR 0112): point-in-time S&P 500 membership, one row per
-- stretch a symbol was a member. The worker writes it from the imported file; everyone reads it.
CREATE TABLE "group_membership_period" (
	"group_id" text NOT NULL,
	"symbol" text NOT NULL,
	"instrument_id" uuid,
	"from_date" date NOT NULL,
	"to_date" date,
	"source" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_membership_period_pk" PRIMARY KEY("group_id","symbol","from_date"),
	CONSTRAINT "group_membership_period_group" CHECK ("group_membership_period"."group_id" = 'sp500'),
	CONSTRAINT "group_membership_period_dates" CHECK ("group_membership_period"."to_date" is null or "group_membership_period"."to_date" > "group_membership_period"."from_date")
);
--> statement-breakpoint
ALTER TABLE "group_membership_period" ADD CONSTRAINT "group_membership_period_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_membership_period_dates_idx" ON "group_membership_period" USING btree ("group_id","from_date","to_date");--> statement-breakpoint
CREATE INDEX "group_membership_period_instrument_idx" ON "group_membership_period" USING btree ("instrument_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "group_membership_period" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "group_membership_period" TO tm_app;
