// MVP: pgvector requires a fixed column dimension, and mixing embedding
// models within one KnowledgeBase is a real engineering problem (different
// dimensions can't share a vector column), not just a validation nicety —
// so exactly one dimension is supported until that's deliberately solved.
export const PLATFORM_EMBEDDING_DIM = 1536;

// Sanity DoS bound on presign requests, not an S3/R2 limit — kept safely
// under Postgres's 32-bit `Document.sizeBytes` column ceiling (~2 GiB).
export const MAX_UPLOAD_SIZE_BYTES = 1 * 1024 * 1024 * 1024;

// Independent per-document ceiling on how many chunks (and therefore how
// many embedding-provider calls) a single document can generate —
// separate from, and enforced well below, an org's shared daily embedding
// token budget (packages/usage/src/embedding-guard.ts, default 2,000,000
// tokens/day). That budget eventually catches a pathological document too,
// but only after the whole batch that crosses it has already been
// embedded and billed — for a single huge or degenerate file, that can
// mean one document alone consumes an entire org's daily budget before
// anything stops it. This cap fails the document immediately, in
// chunk-text (before any embed-chunks job is enqueued), so the blast
// radius of one bad document is always bounded independent of the org's
// budget size. At ~700 target tokens/chunk (apps/worker/src/lib/chunk-text.ts),
// 1000 chunks is roughly 700k tokens — well under the daily default, and
// far beyond what a real single document should ever legitimately need.
export const MAX_CHUNKS_PER_DOCUMENT = 1000;

// MVP: PDF is the entire supported data source (docs/decisions.md — "PDF
// upload is the entire MVP data source"; docs/architecture.md §4.1 —
// extraction is deliberately factored behind an interface so DOCX/HTML/
// TXT/Markdown are additive later, not built yet). One source of truth so
// the presign-time check (packages/shared) and the worker's own extraction
// check (apps/worker) can't drift apart on the accepted type.
export const SUPPORTED_DOCUMENT_MIME_TYPES = ["application/pdf"] as const;

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
  // Scheduled maintenance, not part of the ingestion flow itself — finds
  // Documents stuck in QUEUED/PROCESSING past a threshold and fails them
  // visibly (docs/architecture.md §6.2, docs/decisions.md R8).
  sweep: "document-sweep",
  // DELETE /kb/:id async path — a KB with more chunks than
  // KB_DELETION_ASYNC_CHUNK_THRESHOLD gets its S3 objects and rows torn
  // down by a worker job instead of inline in the request (see
  // apps/api/src/lib/kb-cleanup.ts).
  kbCleanup: "kb-cleanup",
  // DELETE /documents/:id's retry-safe S3 cleanup fallback (see
  // apps/api/src/lib/document-cleanup.ts) — its own queue rather than
  // reusing kbCleanup: a single-document S3 delete is a much lighter,
  // more frequent operation than a whole-KB cascade, and this repo's own
  // convention (see the comment above this block) is one queue per
  // concern for independent concurrency control, not overloading an
  // existing queue with a second, unrelated job type.
  documentCleanup: "document-cleanup",
  // Generic transactional email delivery (currently: signup OTP codes) —
  // apps/api builds the message content, apps/worker just delivers it via
  // whichever EmailProvider is configured (@raas/providers). Its own
  // queue rather than piggybacking on an existing one: email delivery has
  // a different failure/latency profile (an external provider outage)
  // than S3 cleanup or document ingestion and shouldn't compete with or
  // be conflated with either in metrics/concurrency.
  email: "email-delivery",
} as const;

export const JOB_NAMES = {
  processDocument: "process-document",
  extractText: "extract-text",
  chunkText: "chunk-text",
  embedChunks: "embed-chunks",
  sweepStuckDocuments: "sweep-stuck-documents",
  cleanupKnowledgeBase: "cleanup-knowledge-base",
  cleanupDocumentStorage: "cleanup-document-storage",
  sendTransactionalEmail: "send-transactional-email",
} as const;
