// MVP: pgvector requires a fixed column dimension, and mixing embedding
// models within one KnowledgeBase is a real engineering problem (different
// dimensions can't share a vector column), not just a validation nicety —
// so exactly one dimension is supported until that's deliberately solved.
export const PLATFORM_EMBEDDING_DIM = 1536;

// Sanity DoS bound on presign requests, not an S3/R2 limit — kept safely
// under Postgres's 32-bit `Document.sizeBytes` column ceiling (~2 GiB).
export const MAX_UPLOAD_SIZE_BYTES = 1 * 1024 * 1024 * 1024;

// BullMQ queue/job names shared by apps/api (enqueues the flow after
// POST /documents/:id/complete) and apps/worker (defines the processors
// that consume it) — kept in one place so the two apps can't drift apart
// on a typo'd queue name. Grouped by concern for independent concurrency
// control (see docs/architecture.md §6.1): document-processing runs the
// parent orchestration job, document-extraction is CPU-bound (PDF parsing
// + chunking), document-embedding is rate-limited by the provider's quota.
export const QUEUE_NAMES = {
  processing: "document-processing",
  extraction: "document-extraction",
  embedding: "document-embedding",
} as const;

export const JOB_NAMES = {
  processDocument: "process-document",
  extractText: "extract-text",
  chunkText: "chunk-text",
  embedChunks: "embed-chunks",
} as const;
