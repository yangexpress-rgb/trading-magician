ALTER TABLE "data_route" ADD CONSTRAINT "data_route_id_user_uq" UNIQUE("id","user_id");--> statement-breakpoint
CREATE TYPE "public"."strategy_instrument_role" AS ENUM('condition', 'order');--> statement-breakpoint
CREATE TYPE "public"."strategy_phase" AS ENUM('entry', 'exit');--> statement-breakpoint
CREATE TYPE "public"."strategy_status" AS ENUM('created', 'under_testing', 'actively_executing', 'off');--> statement-breakpoint
CREATE TABLE "strategy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "strategy_status" DEFAULT 'created' NOT NULL,
	"draft_definition" jsonb NOT NULL,
	"draft_schema_version" integer NOT NULL,
	"draft_hash" text NOT NULL,
	"current_version_id" uuid,
	"has_been_active" boolean DEFAULT false NOT NULL,
	"base_currency" char(3) NOT NULL,
	"timezone" text NOT NULL,
	"data_route_id" uuid,
	"default_account_id" uuid,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "strategy_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "strategy_name_length" CHECK (char_length("strategy"."name") between 1 and 120),
	CONSTRAINT "strategy_description_length" CHECK (char_length("strategy"."description") <= 2000),
	CONSTRAINT "strategy_tags_count" CHECK (coalesce(array_length("strategy"."tags", 1), 0) <= 20)
);
--> statement-breakpoint
CREATE TABLE "strategy_instrument" (
	"user_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"phase" "strategy_phase" NOT NULL,
	"role" "strategy_instrument_role" NOT NULL,
	CONSTRAINT "strategy_instrument_uq" UNIQUE("strategy_id","instrument_id","phase","role")
);
--> statement-breakpoint
CREATE TABLE "strategy_status_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"from_status" "strategy_status" NOT NULL,
	"to_status" "strategy_status" NOT NULL,
	"version_id" uuid,
	"reason" text,
	"acknowledged_warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_version_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "strategy_version_no_uq" UNIQUE("strategy_id","version_no"),
	CONSTRAINT "strategy_version_no_positive" CHECK ("strategy_version"."version_no" > 0)
);
--> statement-breakpoint
ALTER TABLE "strategy" ADD CONSTRAINT "strategy_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy" ADD CONSTRAINT "strategy_data_route_id_user_id_data_route_id_user_id_fk" FOREIGN KEY ("data_route_id","user_id") REFERENCES "public"."data_route"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy" ADD CONSTRAINT "strategy_default_account_id_user_id_trading_account_id_user_id_fk" FOREIGN KEY ("default_account_id","user_id") REFERENCES "public"."trading_account"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_instrument" ADD CONSTRAINT "strategy_instrument_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_instrument" ADD CONSTRAINT "strategy_instrument_strategy_id_user_id_strategy_id_user_id_fk" FOREIGN KEY ("strategy_id","user_id") REFERENCES "public"."strategy"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_status_change" ADD CONSTRAINT "strategy_status_change_strategy_id_user_id_strategy_id_user_id_fk" FOREIGN KEY ("strategy_id","user_id") REFERENCES "public"."strategy"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_status_change" ADD CONSTRAINT "strategy_status_change_version_id_user_id_strategy_version_id_user_id_fk" FOREIGN KEY ("version_id","user_id") REFERENCES "public"."strategy_version"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_version" ADD CONSTRAINT "strategy_version_strategy_id_user_id_strategy_id_user_id_fk" FOREIGN KEY ("strategy_id","user_id") REFERENCES "public"."strategy"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strategy_user_updated_idx" ON "strategy" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "strategy_instrument_lookup_idx" ON "strategy_instrument" USING btree ("user_id","instrument_id");--> statement-breakpoint
CREATE INDEX "strategy_status_change_strategy_idx" ON "strategy_status_change" USING btree ("strategy_id","changed_at");
