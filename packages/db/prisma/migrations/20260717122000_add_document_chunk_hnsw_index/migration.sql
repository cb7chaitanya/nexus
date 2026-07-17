-- Approximate nearest-neighbor index for cosine similarity search
-- (packages/core's searchSimilarChunks orders by `embedding <=> $vector`).
-- Deliberately its own migration, separate from any schema-shape change:
-- an index build on an existing, populated table has different
-- operational characteristics (potential build time, locking) than a
-- CREATE TABLE, and is easiest to reason about/monitor in isolation.
--
-- Plain CREATE INDEX, not CONCURRENTLY: fine for a fresh/low-traffic
-- table. A real production rollout against a live, actively-written
-- table would want CONCURRENTLY instead — but that cannot run inside a
-- transaction block, which is a real wrinkle against Prisma's
-- transaction-wrapped migrations, and is out of scope for this ticket.
-- Flagged here rather than silently ignored.
--
-- Default HNSW parameters (m=16, ef_construction=64) — not tuned, no
-- WITH clause, matching pgvector's own defaults.
CREATE INDEX document_chunk_embedding_idx
ON "DocumentChunk"
USING hnsw (embedding vector_cosine_ops);
