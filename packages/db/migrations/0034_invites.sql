CREATE TABLE "invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" char(64) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"claimed_by" uuid,
	CONSTRAINT "invite_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_claimed_by_user_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;