-- CreateEnum
CREATE TYPE "KnowledgeBaseStatus" AS ENUM ('ACTIVE', 'DELETING');

-- Note: prisma's diff engine also proposed `DROP INDEX
-- "document_chunk_embedding_idx"` here — the same false-positive artifact
-- as every prior migration touching a column near it: the HNSW index is
-- hand-written raw SQL (see 20260717122000_add_document_chunk_hnsw_index)
-- with no Prisma-schema representation. Deliberately omitted.

-- AlterTable
ALTER TABLE "KnowledgeBase" ADD COLUMN     "description" TEXT,
ADD COLUMN     "status" "KnowledgeBaseStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "createdBy" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_hashedKey_key" ON "ApiKey"("hashedKey");

-- CreateIndex
CREATE INDEX "ApiKey_organizationId_idx" ON "ApiKey"("organizationId");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Deliberately no ROW LEVEL SECURITY on "ApiKey" — same reasoning as
-- "OrganizationInvite" (see 20260715081738_add_organization_invites):
-- a future API-key-authenticated request path has to resolve
-- organizationId FROM the key itself, before any tenant context exists
-- to scope a query by. The session-authenticated management routes this
-- migration's app-layer changes add always have organizationId from an
-- authenticated, membership-checked session already, and filter by it
-- explicitly in every query.
