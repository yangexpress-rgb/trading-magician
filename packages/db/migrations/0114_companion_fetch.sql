CREATE TABLE "companion_fetch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"request" jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"answer" jsonb,
	"error" text,
	CONSTRAINT "companion_fetch_kind" CHECK ("companion_fetch"."kind" in ('members', 'bars', 'filings', 'events'))
);
--> statement-breakpoint
ALTER TABLE "companion_fetch" ADD CONSTRAINT "companion_fetch_connection_id_agent_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."agent_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_fetch" ADD CONSTRAINT "companion_fetch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companion_fetch_pending_idx" ON "companion_fetch" USING btree ("requested_at") WHERE "companion_fetch"."answered_at" is null and "companion_fetch"."error" is null;--> statement-breakpoint
CREATE INDEX "companion_fetch_connection_idx" ON "companion_fetch" USING btree ("connection_id","requested_at");--> statement-breakpoint
-- What the Local Companion asks the cloud for (ADR 0118). The web app writes a
-- person's own requests and reads (then deletes) the answers; the worker
-- (tm_secrets) answers every person's and clears what nobody read.
ALTER TABLE "companion_fetch" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "companion_fetch" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "companion_fetch" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
CREATE POLICY batch_service ON "companion_fetch" TO tm_secrets USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "companion_fetch" TO tm_app;
--> statement-breakpoint
GRANT SELECT, DELETE, UPDATE (claimed_until, answered_at, answer, error) ON "companion_fetch" TO tm_secrets;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY definer_access ON "companion_fetch" TO %I USING (true) WITH CHECK (true)', current_user);
END
$$;
