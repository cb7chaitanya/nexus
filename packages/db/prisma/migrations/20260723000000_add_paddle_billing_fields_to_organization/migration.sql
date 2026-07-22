-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "paddleCustomerId" TEXT,
ADD COLUMN     "paddleSubscriptionId" TEXT,
ADD COLUMN     "subscriptionStatus" TEXT,
ADD COLUMN     "subscriptionUpdatedAt" TIMESTAMP(3);

-- Prisma's migrate-diff engine also proposed dropping
-- document_chunk_embedding_idx here, same recurring false-positive every
-- migration since 20260717122000_add_document_chunk_hnsw_index has had to
-- omit (see that migration's own comment, and every migration since) —
-- that HNSW index is hand-written raw SQL with no schema.prisma
-- representation, not real drift. Deliberately not applied here either.
