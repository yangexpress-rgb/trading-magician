CREATE TABLE "account_valuation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"session_date" date NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"final" boolean DEFAULT false NOT NULL,
	"starting_equity" numeric,
	"app_equity" numeric,
	"broker_equity" numeric,
	"broker_cash" numeric,
	"realized" numeric NOT NULL,
	"unrealized" numeric NOT NULL,
	"fees" numeric NOT NULL,
	"market_value" numeric NOT NULL,
	"stale_marks" integer DEFAULT 0 NOT NULL,
	"difference" numeric,
	"position_differences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	CONSTRAINT "account_valuation_session_uq" UNIQUE("account_id","session_date")
);
--> statement-breakpoint
CREATE TABLE "book_valuation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"runtime_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"session_date" date NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"quantity" numeric NOT NULL,
	"cost_basis" numeric NOT NULL,
	"mark" numeric,
	"mark_at" timestamp with time zone,
	"mark_stale" boolean DEFAULT false NOT NULL,
	"market_value" numeric NOT NULL,
	"unrealized" numeric NOT NULL,
	"realized" numeric NOT NULL,
	"realized_gross" numeric NOT NULL,
	"fees" numeric NOT NULL,
	"open_fees" numeric NOT NULL,
	CONSTRAINT "book_valuation_session_uq" UNIQUE("runtime_id","account_id","instrument_id","session_date")
);
--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "starting_equity" numeric;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "valued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "valuation_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_valuation" ADD CONSTRAINT "account_valuation_account_id_user_id_trading_account_id_user_id_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."trading_account"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_valuation" ADD CONSTRAINT "book_valuation_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_valuation" ADD CONSTRAINT "book_valuation_account_id_user_id_trading_account_id_user_id_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."trading_account"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_valuation" ADD CONSTRAINT "book_valuation_runtime_id_user_id_strategy_runtime_id_user_id_fk" FOREIGN KEY ("runtime_id","user_id") REFERENCES "public"."strategy_runtime"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_valuation_user_idx" ON "account_valuation" USING btree ("user_id","session_date");--> statement-breakpoint
CREATE INDEX "book_valuation_user_idx" ON "book_valuation" USING btree ("user_id","session_date");