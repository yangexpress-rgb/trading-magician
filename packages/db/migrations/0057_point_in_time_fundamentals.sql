-- Design v1.2 item 6 (N34, ADR 0043): point-in-time fundamentals. Each value a
-- company's filings support becomes visible at the filing's acceptance time; a
-- restatement is a new row. Filings are public, so rows are shared by every
-- tenant, and only the worker (tm_secrets) can read or write them.
CREATE TABLE "fundamental_company" (
	"cik" integer PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "fundamental_company_status" CHECK ("fundamental_company"."status" in ('ok', 'missing'))
);
--> statement-breakpoint
CREATE TABLE "fundamental_observation" (
	"cik" integer NOT NULL,
	"field" text NOT NULL,
	"value" numeric NOT NULL,
	"period_end" date NOT NULL,
	"available_from" timestamp with time zone NOT NULL,
	"accession" text NOT NULL,
	"form" text NOT NULL,
	CONSTRAINT "fundamental_observation_pk" PRIMARY KEY("cik","field","accession")
);
--> statement-breakpoint
ALTER TABLE "fundamental_observation" ADD CONSTRAINT "fundamental_observation_cik_fundamental_company_cik_fk" FOREIGN KEY ("cik") REFERENCES "public"."fundamental_company"("cik") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fundamental_company_symbol_idx" ON "fundamental_company" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "fundamental_observation_lookup_idx" ON "fundamental_observation" USING btree ("cik","available_from");--> statement-breakpoint
ALTER TABLE "fundamental_company" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY worker_only ON "fundamental_company" TO tm_secrets USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fundamental_company" TO tm_secrets;--> statement-breakpoint
ALTER TABLE "fundamental_observation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY worker_only ON "fundamental_observation" TO tm_secrets USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fundamental_observation" TO tm_secrets;
