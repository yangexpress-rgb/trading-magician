CREATE TABLE "price_range_52w" (
	"instrument_id" uuid PRIMARY KEY NOT NULL,
	"as_of" date NOT NULL,
	"close" double precision NOT NULL,
	"low" double precision NOT NULL,
	"low_on" date NOT NULL,
	"low_days" integer NOT NULL,
	"high" double precision NOT NULL,
	"high_on" date NOT NULL,
	"high_days" integer NOT NULL,
	"tail_low" double precision NOT NULL,
	"tail_low_on" date NOT NULL,
	"tail_low_days" integer NOT NULL,
	"tail_high" double precision NOT NULL,
	"tail_high_on" date NOT NULL,
	"tail_high_days" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_range_52w_order" CHECK ("price_range_52w"."low" > 0 AND "price_range_52w"."low" <= "price_range_52w"."high"),
	CONSTRAINT "price_range_52w_days" CHECK ("price_range_52w"."low_days" >= 0 AND "price_range_52w"."high_days" >= 0)
);
--> statement-breakpoint
ALTER TABLE "price_range_52w" ADD CONSTRAINT "price_range_52w_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 52-week lows and highs (N290, ADR 0099). Public market data kept once for
-- every tenant: only the worker login (tm_secrets) writes it; the app login
-- reads it for the stock screener and Price charts.
GRANT SELECT, INSERT, UPDATE ON "price_range_52w" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "price_range_52w" TO tm_app;
