CREATE TABLE "companion_push" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"client_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	CONSTRAINT "companion_push_key_uq" UNIQUE("connection_id","client_key"),
	CONSTRAINT "companion_push_kind" CHECK ("companion_push"."kind" in ('ml_run', 'ml_evaluation', 'ml_report')),
	CONSTRAINT "companion_push_key" CHECK (char_length("companion_push"."client_key") BETWEEN 1 AND 120)
);
--> statement-breakpoint
ALTER TABLE "ml_model_run" ADD COLUMN "source" text DEFAULT 'cloud' NOT NULL;--> statement-breakpoint
ALTER TABLE "ml_model_run" ADD COLUMN "source_detail" text;--> statement-breakpoint
ALTER TABLE "companion_push" ADD CONSTRAINT "companion_push_connection_id_agent_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."agent_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_push" ADD CONSTRAINT "companion_push_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companion_push_pending_idx" ON "companion_push" USING btree ("received_at") WHERE "companion_push"."applied_at" is null and "companion_push"."error" is null;--> statement-breakpoint
CREATE INDEX "companion_push_user_idx" ON "companion_push" USING btree ("user_id","received_at");--> statement-breakpoint
ALTER TABLE "ml_model_run" ADD CONSTRAINT "ml_model_run_source" CHECK ("ml_model_run"."source" in ('cloud', 'companion'));--> statement-breakpoint
-- The Local Companion's inbox (ADR 0117). The web app writes a person's own
-- pushes and reads them back; the worker (tm_secrets) applies every person's.
ALTER TABLE "companion_push" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_push" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "companion_push" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
CREATE POLICY batch_service ON "companion_push" TO tm_secrets USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "companion_push" TO tm_app;
--> statement-breakpoint
GRANT SELECT, UPDATE (applied_at, result, error) ON "companion_push" TO tm_secrets;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY definer_access ON "companion_push" TO %I USING (true) WITH CHECK (true)', current_user);
END
$$;
