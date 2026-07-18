-- AlterEnum
ALTER TYPE "DocumentStatus" ADD VALUE 'DELETED';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;

-- Prisma's migrate-dev diff engine proposed dropping
-- document_chunk_embedding_idx here, because that HNSW index was created
-- by hand-written raw SQL (see migration
-- 20260717122000_add_document_chunk_hnsw_index) rather than expressed in
-- schema.prisma — Prisma's schema DSL has no syntax for pgvector's
-- USING hnsw / vector_cosine_ops, so this index can never be represented
-- there, and every future `migrate dev` will keep proposing the same drop
-- for the same reason. Deliberately not applied: dropping it would fall
-- vector similarity search back to a full sequential scan. Left as a
-- comment, not a no-op statement, so this intentional deviation is
-- visible to the next person reading this file rather than silently
-- absent.
