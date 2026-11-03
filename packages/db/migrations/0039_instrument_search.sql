ALTER TABLE "instrument_lookup" ALTER COLUMN "symbol" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "instrument_lookup" ADD COLUMN "query" text;--> statement-breakpoint
ALTER TABLE "instrument_lookup" ADD COLUMN "candidates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "instrument_lookup" ADD CONSTRAINT "instrument_lookup_has_text" CHECK ("instrument_lookup"."symbol" IS NOT NULL OR "instrument_lookup"."query" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "instrument_lookup" ADD CONSTRAINT "instrument_lookup_query" CHECK (length("instrument_lookup"."query") BETWEEN 1 AND 60);