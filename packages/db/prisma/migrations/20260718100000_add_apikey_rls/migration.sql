-- ApiKey gets a real RLS policy — the "no RLS backstop" reasoning
-- recorded on this table (schema.prisma's ApiKey comment, and the
-- identical comment in 20260717163100_kb_org_workspace_apikey_crud)
-- predates requireApiKeyAuth (apps/api/src/plugins/api-key-auth.ts): the
-- chicken-and-egg problem it named — resolving organizationId FROM the
-- key itself, before any org context exists to scope a query by — is the
-- exact same shape OrganizationMember's self-lookup already solved for
-- session auth (see 20260715081815_add_self_membership_lookup). It gets
-- the same fix: a second, narrowly-scoped permissive policy, not "no RLS
-- at all".
--
-- The application role (raas_app) gets no bypass of any kind here — see
-- ADR-9 (docs/decisions.md): it is not SUPERUSER and has no BYPASSRLS.
-- Every access path to this table, including the hash lookup below, is
-- mediated by an explicit RLS policy, never an app-role exemption.
--
-- missing_ok=true (current_setting(..., true)) on BOTH policies from the
-- start, not added as a follow-up fix — 20260715081815 already discovered
-- that an unguarded current_setting() call in one policy raises an
-- unconditional error that kills the whole query even when a SIBLING
-- permissive policy would otherwise have allowed it (Postgres does not
-- let one permissive policy "rescue" a query from another policy's own
-- qual-evaluation error). Getting this right from the first migration
-- avoids reproducing that exact bug here.

ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "ApiKey"
  USING ("organizationId" = current_setting('app.current_org_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org_id', true));

-- SELECT-only, scoped by a NEW session variable (app.current_api_key_hash,
-- set via withApiKeyLookup — packages/db/src/tenant.ts) that only ever
-- carries a SHA-256 hash the caller already computed from a bearer token
-- it possesses. Grants visibility into exactly the one row matching that
-- hash, nothing else — "possession of the hash is the access grant," the
-- same shape OrganizationInvite's hashedToken already relies on
-- (schema.prisma's comment on that model), just backed by an actual RLS
-- policy instead of an application-level filter. Does not grant
-- INSERT/UPDATE/DELETE — creating, listing, and revoking keys still goes
-- through the policy above with real org context (apps/api/src/routes/
-- api-keys.ts already has organizationId from an authenticated,
-- membership-checked session, via withTenantTransaction).
CREATE POLICY "api_key_hash_lookup" ON "ApiKey"
  FOR SELECT
  USING ("hashedKey" = current_setting('app.current_api_key_hash', true));
