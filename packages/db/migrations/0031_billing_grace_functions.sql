-- apply_subscription also stores the grace period (ADR 0024).
DROP FUNCTION apply_subscription(uuid, text, text, subscription_status, text, text, timestamptz, boolean, text);
--> statement-breakpoint
CREATE FUNCTION apply_subscription(
  p_user uuid, p_customer text, p_subscription text, p_status subscription_status,
  p_price text, p_plan text, p_period_end timestamptz, p_cancel boolean, p_entitled_plan text,
  p_grace_ends_at timestamptz)
  RETURNS TABLE (previous_plan text, previous_status subscription_status, applied boolean)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_plan text;
  v_existing subscription%ROWTYPE;
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM app_current_user_id() THEN
    RAISE EXCEPTION 'apply_subscription is only for the current tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT plan_code INTO v_plan FROM entitlement WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no entitlement for this user' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_existing FROM subscription WHERE user_id = p_user FOR UPDATE;

  IF FOUND AND v_existing.subscription_id IS DISTINCT FROM p_subscription
     AND v_existing.status IN ('active', 'trialing', 'past_due')
     AND p_status NOT IN ('active', 'trialing', 'past_due') THEN
    RETURN QUERY SELECT v_plan, v_existing.status, false;
    RETURN;
  END IF;

  INSERT INTO subscription AS s (user_id, customer_id, subscription_id, status, price_id,
      plan_code, current_period_end, cancel_at_period_end, grace_ends_at, synced_at,
      sync_lease_expires_at)
    VALUES (p_user, p_customer, p_subscription, p_status, p_price, p_plan, p_period_end,
      p_cancel, p_grace_ends_at, now(), NULL)
    ON CONFLICT (user_id) DO UPDATE
      SET customer_id = excluded.customer_id, subscription_id = excluded.subscription_id,
          status = excluded.status, price_id = excluded.price_id, plan_code = excluded.plan_code,
          current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end,
          grace_ends_at = excluded.grace_ends_at, synced_at = now(),
          sync_lease_expires_at = NULL;

  IF p_entitled_plan IS NOT NULL AND p_entitled_plan IS DISTINCT FROM v_plan THEN
    UPDATE entitlement SET plan_code = p_entitled_plan, row_version = row_version + 1
     WHERE user_id = p_user;
  END IF;
  RETURN QUERY SELECT v_plan, v_existing.status, true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION apply_subscription(uuid, text, text, subscription_status, text, text, timestamptz, boolean, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION apply_subscription(uuid, text, text, subscription_status, text, text, timestamptz, boolean, text, timestamptz) TO tm_app;
--> statement-breakpoint
-- Workspaces in a payment grace period, for the worker's notices and its end (ADR 0024).
CREATE FUNCTION billing_grace_due(p_limit integer)
  RETURNS TABLE (due_user uuid)
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT user_id FROM subscription
     WHERE grace_ends_at IS NOT NULL AND status IN ('past_due', 'unpaid')
     ORDER BY grace_ends_at
     LIMIT least(greatest(p_limit, 1), 500)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_grace_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_grace_due(integer) TO tm_app;
