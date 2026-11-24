ALTER TYPE "public"."agent_scope" ADD VALUE 'research_sync';--> statement-breakpoint
CREATE TABLE "research_companion" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"version" text NOT NULL,
	"platform" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"last_push_at" timestamp with time zone,
	"last_push_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_companion_version" CHECK (char_length("research_companion"."version") BETWEEN 1 AND 40),
	CONSTRAINT "research_companion_platform" CHECK (char_length("research_companion"."platform") BETWEEN 1 AND 40)
);
--> statement-breakpoint
ALTER TABLE "research_companion" ADD CONSTRAINT "research_companion_connection_id_agent_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."agent_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_companion" ADD CONSTRAINT "research_companion_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_companion_user_idx" ON "research_companion" USING btree ("user_id","seen_at");--> statement-breakpoint
ALTER TABLE "research_companion" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "research_companion" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "research_companion" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "research_companion" TO tm_app;
--> statement-breakpoint
GRANT UPDATE (version, platform, seen_at, last_push_at, last_push_kind) ON "research_companion" TO tm_app;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY definer_access ON "research_companion" TO %I USING (true) WITH CHECK (true)', current_user);
END
$$;
--> statement-breakpoint
-- Whether the shared research producer (the platform admin's companion) has
-- been seen lately: research pages read it for every member, so it is a
-- SECURITY DEFINER read of one timestamp, never of anyone's connection.
CREATE FUNCTION research_companion_seen_at(p_user uuid) RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT max(c.seen_at) FROM research_companion AS c
    JOIN agent_connection AS a ON a.id = c.connection_id
   WHERE c.user_id = p_user AND a.revoked_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION research_companion_seen_at(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION research_companion_seen_at(uuid) TO tm_app;
