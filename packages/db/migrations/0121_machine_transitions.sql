CREATE TABLE "strategy_transition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"runtime_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"cycle_id" uuid,
	"decided_on" date NOT NULL,
	"from_state_id" text,
	"to_state_id" text NOT NULL,
	"row_id" text,
	"why" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"completed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_transition_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "strategy_transition_seq_uq" UNIQUE("runtime_id","seq"),
	CONSTRAINT "strategy_transition_seq_positive" CHECK ("strategy_transition"."seq" > 0),
	CONSTRAINT "strategy_transition_kind" CHECK ("strategy_transition"."kind" in ('start', 'switch')),
	CONSTRAINT "strategy_transition_outcome" CHECK ("strategy_transition"."outcome" in ('switched_no_orders', 'rebalancing', 'done', 'incomplete', 'stuck', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "strategy_transition" ADD CONSTRAINT "strategy_transition_runtime_id_user_id_strategy_runtime_id_user_id_fk" FOREIGN KEY ("runtime_id","user_id") REFERENCES "public"."strategy_runtime"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_transition" ADD CONSTRAINT "strategy_transition_cycle_id_user_id_strategy_cycle_id_user_id_fk" FOREIGN KEY ("cycle_id","user_id") REFERENCES "public"."strategy_cycle"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- State-machine transitions (brief v1.4 §2.6, ADR 0124 P3a): tenant rows, never deleted.
CREATE TRIGGER strategy_transition_set_updated_at BEFORE UPDATE ON "strategy_transition"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "strategy_transition" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "strategy_transition" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "strategy_transition" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "strategy_transition" TO tm_app;
