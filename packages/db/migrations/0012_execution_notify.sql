-- Live updates for the Orders tab (ADR 0013). Each change notifies the
-- tm_execution channel with the owning user's id only; listeners re-read the
-- data through RLS. NOTIFY folds identical payloads within one transaction.
CREATE FUNCTION notify_execution_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  PERFORM pg_notify('tm_execution', NEW.user_id::text);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER broker_order_notify
  AFTER INSERT OR UPDATE ON broker_order
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
--> statement-breakpoint
CREATE TRIGGER scheduled_action_notify
  AFTER INSERT OR UPDATE OF status, due_at ON scheduled_action
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
--> statement-breakpoint
-- Lease renewals update the runtime on every pass; only status changes matter here.
CREATE TRIGGER strategy_runtime_notify
  AFTER INSERT OR UPDATE OF status, pause_reason ON strategy_runtime
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
--> statement-breakpoint
CREATE TRIGGER execution_control_notify
  AFTER INSERT OR UPDATE ON execution_control
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
