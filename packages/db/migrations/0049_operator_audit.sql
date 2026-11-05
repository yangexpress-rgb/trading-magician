ALTER TABLE "audit_event" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_operator_is_system" CHECK ("audit_event"."user_id" IS NOT NULL OR "audit_event"."actor_type" = 'system');--> statement-breakpoint
-- Operator actions that belong to no workspace, such as minting and releasing
-- invite codes (deviation D6, ADR 0034), are audited with no user. Only the
-- owner connection the operator scripts use may append them, and only as
-- system events; tenants never see them because their policies match on user.
DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY operator_append ON "audit_event" FOR INSERT TO %I WITH CHECK (user_id IS NULL AND actor_type = %L)',
    current_user, 'system');
  EXECUTE format(
    'CREATE POLICY operator_read ON "audit_event" FOR SELECT TO %I USING (user_id IS NULL)',
    current_user);
END
$$;
