CREATE TABLE "credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"environment" "trading_mode" DEFAULT 'paper' NOT NULL,
	"hint" jsonb NOT NULL,
	"key_id" text NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "credential_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "credential_paper_only" CHECK ("credential"."environment" = 'paper')
);
--> statement-breakpoint
-- Nothing has written credential_ref before this migration (demo connections have none).
ALTER TABLE "broker_connection" ALTER COLUMN "credential_ref" SET DATA TYPE uuid USING NULL;--> statement-breakpoint
ALTER TABLE "data_feed_connection" ALTER COLUMN "credential_ref" SET DATA TYPE uuid USING NULL;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_connection" ADD CONSTRAINT "broker_connection_credential_fk" FOREIGN KEY ("credential_ref","user_id") REFERENCES "public"."credential"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_feed_connection" ADD CONSTRAINT "data_feed_connection_credential_fk" FOREIGN KEY ("credential_ref","user_id") REFERENCES "public"."credential"("id","user_id") ON DELETE no action ON UPDATE no action;