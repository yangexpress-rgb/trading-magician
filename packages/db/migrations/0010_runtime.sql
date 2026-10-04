CREATE TABLE "broker_sync" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"cursor" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_control" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"halted_at" timestamp with time zone,
	"halted_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_order" (
	"broker_order_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"client_order_id" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text NOT NULL,
	"filled" numeric DEFAULT '0' NOT NULL,
	"triggered" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"accepted_at" timestamp with time zone NOT NULL,
	"update_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "paper_order_client_uq" UNIQUE("account_id","client_order_id"),
	CONSTRAINT "paper_order_status" CHECK ("paper_order"."status" in ('working', 'filled', 'canceled', 'expired', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "paper_position" (
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"quantity" numeric NOT NULL,
	"average_cost" numeric,
	CONSTRAINT "paper_position_uq" UNIQUE("account_id","instrument_id")
);
--> statement-breakpoint
CREATE TABLE "paper_update" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "paper_update_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"broker_order_id" text NOT NULL,
	"update" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_intent" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_cycle" ADD COLUMN "state" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_runtime" ADD COLUMN "state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "broker_sync" ADD CONSTRAINT "broker_sync_account_id_user_id_trading_account_id_user_id_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."trading_account"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_control" ADD CONSTRAINT "execution_control_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_order" ADD CONSTRAINT "paper_order_account_id_user_id_trading_account_id_user_id_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."trading_account"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_position" ADD CONSTRAINT "paper_position_account_id_user_id_trading_account_id_user_id_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."trading_account"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_update" ADD CONSTRAINT "paper_update_account_id_user_id_trading_account_id_user_id_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."trading_account"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_order_working_idx" ON "paper_order" USING btree ("user_id") WHERE "paper_order"."status" = 'working';--> statement-breakpoint
CREATE INDEX "paper_update_account_idx" ON "paper_update" USING btree ("account_id","seq");--> statement-breakpoint
CREATE INDEX "paper_update_order_idx" ON "paper_update" USING btree ("broker_order_id","seq");