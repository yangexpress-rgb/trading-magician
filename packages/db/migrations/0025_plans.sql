CREATE TABLE "plan" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_minor" integer DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"limits" jsonb NOT NULL,
	"offered" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_price_not_negative" CHECK ("plan"."price_minor" >= 0),
	CONSTRAINT "plan_paper_only" CHECK (coalesce(("plan"."limits" ->> 'realIntegrations')::boolean, false) = false)
);
--> statement-breakpoint
ALTER TABLE "entitlement" ALTER COLUMN "limits" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlement" ADD COLUMN "overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_one_default" ON "plan" USING btree ("is_default") WHERE "plan"."is_default";--> statement-breakpoint
-- The starting catalog (Phase 6 plan, approved 2026-10-05). Prices and limits are
-- placeholders the owner can change by updating these rows.
INSERT INTO "plan" ("code", "name", "description", "price_minor", "limits", "offered", "is_default", "sort_order") VALUES
  ('free', 'Free', 'Paper trading on the demo account.', 0,
   '{"savedStrategies":3,"activeStrategies":1,"backtestRunsPerDay":10,"concurrentBacktests":1,"connectedAccounts":1,"paperIntegrations":false,"liveData":false,"realIntegrations":false}',
   true, true, 10),
  ('pro', 'Pro', 'More strategies and back tests, with Alpaca paper trading and market data.', 2000,
   '{"savedStrategies":25,"activeStrategies":5,"backtestRunsPerDay":100,"concurrentBacktests":2,"connectedAccounts":5,"paperIntegrations":true,"liveData":true,"realIntegrations":false}',
   true, false, 20),
  ('dev', 'Development', 'For the people building the app. Not offered.', 0,
   '{"savedStrategies":50,"activeStrategies":5,"backtestRunsPerDay":100,"concurrentBacktests":2,"connectedAccounts":3,"paperIntegrations":true,"liveData":true,"realIntegrations":false}',
   false, false, 90);--> statement-breakpoint
-- Every workspace so far was given the dev plan's limits; they stay on it.
UPDATE "entitlement" SET "plan_code" = 'dev' WHERE "plan_code" NOT IN (SELECT "code" FROM "plan");--> statement-breakpoint
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_plan_code_plan_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plan"("code") ON DELETE no action ON UPDATE no action;