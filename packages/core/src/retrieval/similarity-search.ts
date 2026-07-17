import type { Prisma } from "@raas/db";

import type { RetrievedChunk } from "../types.js";

export interface SimilaritySearchParams {
  organizationId: string;
  knowledgeBaseId: string;
  queryEmbedding: number[];
  limit?: number;
}

// architecture.md §4.6: top-k candidates before context assembly truncates
// to a token budget.
const DEFAULT_LIMIT = 8;

interface ChunkRow {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  pageNumber: number | null;
  score: number;
}

/**
 * pgvector cosine-similarity search, scoped to organizationId AND
 * knowledgeBaseId — "the single most important line of SQL in the whole
 * system from a security standpoint" (docs/architecture.md §4.6). Must be
 * called with a `tx` obtained from `withTenantTransaction` — RLS is the
 * backstop, this explicit WHERE clause is the primary, defense-in-depth
 * layer (docs/decisions.md R1). Chunks with a null embedding (chunked but
 * not yet embedded) are excluded.
 *
 * organizationId, knowledgeBaseId, the query vector, and limit are all
 * passed through Prisma's `$queryRaw` tagged template as bound parameters
 * — never string-concatenated into the SQL text. The vector is bound as a
 * string parameter and cast with `::vector` on the Postgres side (Prisma
 * has no native pgvector type — see @raas/db's schema notes); the cast
 * applies to the bound value, not to interpolated SQL, so this is not a
 * string-concatenation injection surface.
 */
export async function searchSimilarChunks(
  tx: Prisma.TransactionClient,
  params: SimilaritySearchParams,
): Promise<RetrievedChunk[]> {
  const { organizationId, knowledgeBaseId, queryEmbedding, limit = DEFAULT_LIMIT } = params;
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  const rows = await tx.$queryRaw<ChunkRow[]>`
    SELECT
      id,
      "documentId",
      "chunkIndex",
      content,
      "pageNumber",
      1 - (embedding <=> ${vectorLiteral}::vector) AS score
    FROM "DocumentChunk"
    WHERE "organizationId" = ${organizationId}
      AND "knowledgeBaseId" = ${knowledgeBaseId}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    chunkId: row.id,
    documentId: row.documentId,
    chunkIndex: row.chunkIndex,
    content: row.content,
    pageNumber: row.pageNumber,
    score: row.score,
  }));
}
