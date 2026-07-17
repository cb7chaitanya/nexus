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
}
