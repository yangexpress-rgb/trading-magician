CREATE TABLE "execution_incident" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"runtime_id" uuid,
	"account_id" uuid,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paused_runtimes" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_incident_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "execution_incident_kind" CHECK ("execution_incident"."kind" in ('reconciliation_mismatch', 'repeated_rejects', 'stale_data', 'feed_loss', 'broker_disconnected')),
	CONSTRAINT "execution_incident_summary_length" CHECK (char_length("execution_incident"."summary") <= 500),
	CONSTRAINT "execution_incident_resolution_length" CHECK (char_length("execution_incident"."resolution") <= 500),
	CONSTRAINT "execution_incident_resolved" CHECK (("execution_incident"."resolved_at" is null) = ("execution_incident"."resolved_by" is null))
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text,
	"resource_type" text,
	"resource_id" uuid,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notification_dedupe_uq" UNIQUE("user_id","dedupe_key"),
	CONSTRAINT "notification_kind" CHECK ("notification"."kind" in ('strategy_started', 'strategy_stopped', 'triggered', 'order_rejected', 'partial_fill', 'filled', 'disconnect', 'stale_data', 'risk_pause', 'reconciliation_mismatch')),
	CONSTRAINT "notification_title_length" CHECK (char_length("notification"."title") <= 200),
	CONSTRAINT "notification_body_length" CHECK (char_length("notification"."body") <= 1000),
	CONSTRAINT "notification_link_relative" CHECK ("notification"."link" like '/%' and "notification"."link" not like '//%')
);
--> statement-breakpoint
ALTER TABLE "broker_sync" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "strategy_runtime" ADD COLUMN "resumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "execution_incident" ADD CONSTRAINT "execution_incident_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_incident_open_uq" ON "execution_incident" USING btree ("user_id","kind",coalesce("runtime_id"::text, ''),coalesce("account_id"::text, '')) WHERE "execution_incident"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "execution_incident_user_idx" ON "execution_incident" USING btree ("user_id","opened_at");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_unread_idx" ON "notification" USING btree ("user_id") WHERE "notification"."read_at" is null;