-- Note: prisma's diff engine also proposed `DROP INDEX
-- "document_chunk_embedding_idx"` here — a false-positive artifact of the
-- HNSW index being hand-written raw SQL (migration
-- 20260717122000_add_document_chunk_hnsw_index) with no Prisma-schema
-- representation, not an intended change. Deliberately omitted.

-- CreateTable
CREATE TABLE "OrganizationUsageLimit" (
    "organizationId" TEXT NOT NULL,
    "maxDocumentsPerDay" INTEGER NOT NULL,
    "maxEmbeddingTokensPerDay" INTEGER NOT NULL,
    "maxChatTokensPerDay" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationUsageLimit_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "OrganizationUsageLimit" ADD CONSTRAINT "OrganizationUsageLimit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────────────────── Row-Level Security ─────────────────────────
-- Same strict tenant_isolation pattern as DocumentChunk/UsageEvent:
-- missing_ok deliberately omitted — a query reaching this table without
-- going through withTenantTransaction raises a Postgres error rather
-- than silently returning zero rows. Read on the hot path (before every
-- rate-limited/quota-checked operation), so correctness here matters as
-- much as on any tenant data table even though this table holds config,
-- not tenant content.

ALTER TABLE "OrganizationUsageLimit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationUsageLimit" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "OrganizationUsageLimit"
  USING ("organizationId" = current_setting('app.current_org_id'))
  WITH CHECK ("organizationId" = current_setting('app.current_org_id'));
