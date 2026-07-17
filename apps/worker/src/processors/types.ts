// organizationId is carried explicitly on every job payload — not
// re-derived from a documentId lookup — so every processor can call
// withTenantTransaction before its first query, with no bypass role and no
// window where a query runs without RLS scoped (see
// docs/implementation-plan.md §1.1(b)).
export interface DocumentJobData {
  organizationId: string;
  documentId: string;
  knowledgeBaseId: string;
}

export interface EmbedChunksJobData extends DocumentJobData {
  chunkIds: string[];
  /**
   * Idempotency checkpoint — see processors/embed-chunks.ts. Populated via
   * job.updateData() immediately after a successful provider call, before
   * the persistence transaction is attempted, so an already-paid-for
   * vector survives a subsequent transaction failure independent of
   * whatever made Postgres fail (this lives in Redis, as part of the
   * job's own data, not in Postgres). Keyed by DocumentChunk id.
   */
  embeddingCache?: Record<string, number[]>;
}
