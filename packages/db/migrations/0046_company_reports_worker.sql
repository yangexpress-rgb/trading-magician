-- Company pages (ADR 0031): people ask for a company in Quantitative Research,
-- the worker answers from the tenant's company data feed.
CREATE TRIGGER company_report_set_updated_at BEFORE UPDATE ON "company_report"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "company_report" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "company_report" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "company_report" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "company_report" TO tm_app;
--> statement-breakpoint
GRANT UPDATE (status, report, source, message, lease_expires_at, attempts) ON "company_report" TO tm_app;
--> statement-breakpoint
-- The worker claims pending reports across tenants, then answers each in its
-- tenant's scope. Claiming also clears reports older than a day: they are a
-- cache of public filings, not a record.
CREATE FUNCTION claim_company_reports(p_lease_seconds integer, p_limit integer)
  RETURNS TABLE (claimed_id uuid, claimed_user uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid queue arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM company_report WHERE created_at < now() - interval '1 day';

  RETURN QUERY
  UPDATE company_report AS r
     SET lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = r.attempts + 1
   WHERE r.id IN (
           SELECT p.id FROM company_report AS p
            WHERE p.status = 'pending'
              AND (p.lease_expires_at IS NULL OR p.lease_expires_at < now())
            ORDER BY p.created_at
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit)
  RETURNING r.id, r.user_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_company_reports(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_company_reports(integer, integer) TO tm_app;
