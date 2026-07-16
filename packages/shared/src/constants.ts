// MVP: pgvector requires a fixed column dimension, and mixing embedding
// models within one KnowledgeBase is a real engineering problem (different
// dimensions can't share a vector column), not just a validation nicety —
// so exactly one dimension is supported until that's deliberately solved.
export const PLATFORM_EMBEDDING_DIM = 1536;

// Sanity DoS bound on presign requests, not an S3/R2 limit — kept safely
// under Postgres's 32-bit `Document.sizeBytes` column ceiling (~2 GiB).
export const MAX_UPLOAD_SIZE_BYTES = 1 * 1024 * 1024 * 1024;
