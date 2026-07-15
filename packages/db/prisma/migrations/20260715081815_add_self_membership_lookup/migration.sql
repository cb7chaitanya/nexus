-- Resolves the "which orgs does this user belong to" gap flagged in
-- decisions.md while building the RLS foundation: login and GET /auth/me
-- need to query OrganizationMember by userId, with no org context
-- selected yet. The existing tenant_isolation policy can't answer that —
-- it's scoped purely by organizationId.
--
-- Fix has two parts, both required together — verified empirically
-- against a live connection, not assumed:
--
-- 1. A second, SELECT-only permissive policy scoped by a NEW session
--    variable, app.current_user_id, set via withUserContext (src/tenant.ts).
--    Postgres combines multiple permissive policies for the same command
--    with OR.
--
-- 2. The ORIGINAL tenant_isolation policy's current_setting() calls must
--    also switch to missing_ok=true. Without this, a session that sets
--    ONLY app.current_user_id (never app.current_org_id) still throws
--    "unrecognized configuration parameter" from the original policy's
--    unguarded current_setting('app.current_org_id') call — Postgres does
--    not let a sibling permissive policy "rescue" a query when another
--    policy's own qual expression raises an error; the error is
--    unconditional and kills the whole query regardless of what the other
--    policy would have decided. Reproduced this exact failure before
--    applying this fix.
--
-- Net behavior change: OrganizationMember's RLS no longer ever raises a
-- hard error on a missing tenant context — it now always fails closed via
-- an empty result instead. This is consistent with, not a regression of,
-- what decisions.md already concluded was the actual guaranteed
-- invariant ("never returns another tenant's rows — error or nothing,
-- never data"); the "sometimes loud" behavior was already documented as
-- inconsistent (connection-history- and pooler-dependent), and a single
-- uniform behavior is strictly easier to reason about. Workspace's policy
-- is untouched — no user-scoped access pattern is needed there.

DROP POLICY "tenant_isolation" ON "OrganizationMember";

CREATE POLICY "tenant_isolation" ON "OrganizationMember"
  USING ("organizationId" = current_setting('app.current_org_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true));

-- SELECT-only: grants visibility into the calling user's OWN membership
-- rows, nothing else. Does not grant INSERT/UPDATE/DELETE — those still
-- require org context via the policy above (accepting an invite, for
-- example, always knows the target org's id already, so it goes through
-- withTenantTransaction, never withUserContext).
CREATE POLICY "self_membership_lookup" ON "OrganizationMember"
  FOR SELECT
  USING ("userId" = current_setting('app.current_user_id', true));
