-- CreateEnum
CREATE TYPE "UsageEventType" AS ENUM ('CHAT_REQUEST', 'CHAT_PROMPT_TOKENS', 'CHAT_COMPLETION_TOKENS', 'EMBEDDING_TOKENS', 'DOCUMENT_PROCESSED');

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "type" "UsageEventType" NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageEvent_organizationId_type_createdAt_idx" ON "UsageEvent"("organizationId", "type", "createdAt");

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation: same pattern as every other tenant-scoped table in
-- this schema (DocumentChunk, Document, KnowledgeBase). missing_ok is
-- deliberately omitted, same reasoning as those tables — a query reaching
-- UsageEvent without going through withTenantTransaction should error
-- loudly, not silently return zero rows.
ALTER TABLE "UsageEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageEvent" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "UsageEvent"
  USING ("organizationId" = current_setting('app.current_org_id'))
  WITH CHECK ("organizationId" = current_setting('app.current_org_id'));
