-- Note: prisma's diff engine also proposed `DROP INDEX
-- "document_chunk_embedding_idx"` here — the same false-positive artifact
-- already documented in 20260717154011_add_organization_usage_limit (the
-- hand-written HNSW index has no Prisma-schema representation). Deliberately
-- omitted.

-- CreateTable
CREATE TABLE "OrganizationLlmConfig" (
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationLlmConfig_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "OrganizationLlmConfig" ADD CONSTRAINT "OrganizationLlmConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────────────────── Row-Level Security ─────────────────────────
-- Same shape as OrganizationUsageLimit (20260717154011): a single
-- tenant_isolation policy, no api-key-hash-lookup complexity like ApiKey
-- needed, because this table is only ever reached via
-- withTenantTransaction with an organizationId already known from an
-- authenticated, membership-checked session — never resolved FROM this
-- table the way a bearer token resolves an org from ApiKey. missing_ok
-- deliberately omitted, same reasoning as OrganizationUsageLimit: a query
-- reaching this table without tenant context should error, not silently
-- return zero rows — this table gates which provider account a chat
-- request's traffic (and cost) goes to.

ALTER TABLE "OrganizationLlmConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationLlmConfig" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "OrganizationLlmConfig"
  USING ("organizationId" = current_setting('app.current_org_id'))
  WITH CHECK ("organizationId" = current_setting('app.current_org_id'));
