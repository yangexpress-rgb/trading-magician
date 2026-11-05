-- Subscriptions (ADR 0023). Each workspace sees its own; only apply_subscription writes them.
ALTER TABLE "subscription" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "subscription" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT ON "subscription" TO tm_app;
--> statement-breakpoint
CREATE TRIGGER subscription_set_updated_at BEFORE UPDATE ON "subscription"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Event ids already applied. No tenant data: an id, a type and whose it was.
GRANT SELECT, INSERT ON "billing_event" TO tm_app;
--> statement-breakpoint
-- A webhook arrives without a session: find whose customer or subscription it is.
CREATE FUNCTION billing_user_for(p_customer text, p_subscription text) RETURNS uuid
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT user_id FROM subscription
     WHERE (p_subscription IS NOT NULL AND subscription_id = p_subscription)
        OR (p_customer IS NOT NULL AND customer_id = p_customer)
     ORDER BY (subscription_id = p_subscription) DESC NULLS LAST
     LIMIT 1
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_user_for(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_user_for(text, text) TO tm_app;
--> statement-breakpoint
-- Stores the provider's view of the current tenant's subscription and moves its
-- entitlement to p_entitled_plan. Only for the tenant the transaction is scoped to.
-- A late event about an older subscription never replaces a newer one that pays.
CREATE FUNCTION apply_subscription(
  p_user uuid, p_customer text, p_subscription text, p_status subscription_status,
  p_price text, p_plan text, p_period_end timestamptz, p_cancel boolean, p_entitled_plan text)
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
      plan_code, current_period_end, cancel_at_period_end, synced_at, sync_lease_expires_at)
    VALUES (p_user, p_customer, p_subscription, p_status, p_price, p_plan, p_period_end,
      p_cancel, now(), NULL)
    ON CONFLICT (user_id) DO UPDATE
      SET customer_id = excluded.customer_id, subscription_id = excluded.subscription_id,
          status = excluded.status, price_id = excluded.price_id, plan_code = excluded.plan_code,
          current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end, synced_at = now(),
          sync_lease_expires_at = NULL;

  IF p_entitled_plan IS NOT NULL AND p_entitled_plan IS DISTINCT FROM v_plan THEN
    UPDATE entitlement SET plan_code = p_entitled_plan, row_version = row_version + 1
     WHERE user_id = p_user;
  END IF;
  RETURN QUERY SELECT v_plan, v_existing.status, true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION apply_subscription(uuid, text, text, subscription_status, text, text, timestamptz, boolean, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION apply_subscription(uuid, text, text, subscription_status, text, text, timestamptz, boolean, text) TO tm_app;
--> statement-breakpoint
-- Subscriptions due a check against the provider, in case a webhook was missed.
CREATE FUNCTION claim_subscription_syncs(p_lease_seconds integer, p_every_seconds integer, p_limit integer)
  RETURNS TABLE (claimed_user uuid, claimed_subscription text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 OR p_every_seconds NOT BETWEEN 10 AND 86400
     OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid queue arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  UPDATE subscription AS s
     SET sync_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   WHERE s.id IN (
           SELECT t.id FROM subscription AS t
            WHERE t.subscription_id IS NOT NULL
              AND t.status IS DISTINCT FROM 'canceled'
              AND t.status IS DISTINCT FROM 'incomplete_expired'
              AND (t.sync_lease_expires_at IS NULL OR t.sync_lease_expires_at < now())
              AND t.synced_at < now() - make_interval(secs => p_every_seconds)
            ORDER BY t.synced_at
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit)
  RETURNING s.user_id, s.subscription_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_subscription_syncs(integer, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_subscription_syncs(integer, integer, integer) TO tm_app;
