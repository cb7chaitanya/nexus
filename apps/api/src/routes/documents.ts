import { ApiError, completeDocumentSchema, documentIdQuerySchema, parseOrThrow, retryDocumentSchema } from "@raas/shared";
import { withTenantTransaction } from "@raas/db";
import type { FastifyInstance } from "fastify";

import { DOCUMENT_METADATA_BODY_LIMIT_BYTES } from "../lib/body-limits.js";
import { enqueueDocumentIngestion } from "../lib/ingestion-flow.js";
import { requireMembership } from "../lib/membership.js";
import { checkDocumentQuota, checkIngestionRateLimit } from "../lib/rate-limit.js";
import { deleteObjects, objectExists } from "../lib/storage.js";
import { requireAuth } from "../plugins/auth-guard.js";

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/documents/:id/complete",
    // Tighter than the app-wide default (lib/body-limits.ts) — this
    // route's whole body is a single organizationId field.
    { preHandler: requireAuth, bodyLimit: DOCUMENT_METADATA_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const { id: documentId } = request.params as { id: string };
      const input = parseOrThrow(completeDocumentSchema, request.body);
      const userId = request.userId;
      if (!userId) throw ApiError.unauthorized();

      await requireMembership(request, input.organizationId, userId);
      await checkIngestionRateLimit(input.organizationId, reply);
      // Daily ceiling on documents actually queued for processing — checked
      // here (not at presign) since this is the point where the pipeline,
      // and its real OpenAI embedding cost, actually gets triggered. Placed
      // before the S3 existence check and status transition below so an
      // over-quota org gets a fast 429 without the wasted I/O.
      await checkDocumentQuota(input.organizationId, reply);

      // Ownership: the document is looked up scoped to this org's tenant
      // context, so a documentId belonging to another org is
      // indistinguishable from a nonexistent one — RLS enforces this, not
      // an app-level owner check.
      const document = await withTenantTransaction(input.organizationId, (tx) =>
        tx.document.findUnique({ where: { id: documentId } }),
      );
      if (!document) {
        throw ApiError.notFound("Document not found");
      }

      // Status transition: only a document still awaiting its upload can
      // be completed — this call is not a generic "requeue" endpoint.
      if (document.status !== "PENDING_UPLOAD") {
        throw ApiError.conflict(
          `Cannot complete a document in status ${document.status} — only a document in PENDING_UPLOAD can be completed`,
        );
      }

      // Object exists: the client's claim that it finished the S3/R2 PUT
      // is verified against the bucket, not trusted.
      const uploaded = await objectExists(document.storageKey);
      if (!uploaded) {
        throw ApiError.conflict(
          "No uploaded object found for this document — the upload may not have completed",
        );
      }

      const updated = await withTenantTransaction(input.organizationId, (tx) =>
        tx.document.update({ where: { id: documentId }, data: { status: "QUEUED" } }),
      );

      // Enqueued after the QUEUED transition commits, not before — if
      // enqueueing itself fails, the document is left in a real, visible
      // QUEUED state rather than a status that claims work is in flight
      // when it never actually got scheduled.
      await enqueueDocumentIngestion({
        documentId,
        organizationId: input.organizationId,
        knowledgeBaseId: document.knowledgeBaseId,
      });

      reply.send(updated);
    },
  );

  app.get("/documents/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id: documentId } = request.params as { id: string };
    const input = parseOrThrow(documentIdQuerySchema, request.query);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    await requireMembership(request, input.organizationId, userId);

    const document = await withTenantTransaction(input.organizationId, (tx) =>
      tx.document.findUnique({ where: { id: documentId } }),
    );
    if (!document) {
      throw ApiError.notFound("Document not found");
    }

    // Unlike GET /kb/:id/documents (which excludes DELETED — see
    // knowledge-bases.ts), fetching a specific document by id
    // deliberately still succeeds for a DELETED one: that's the audit
    // trail DELETE /documents/:id exists to preserve. A document that
    // never existed, or belongs to another org (RLS), is the only case
    // that 404s.
    reply.send(document);
  });

  app.delete("/documents/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id: documentId } = request.params as { id: string };
    const input = parseOrThrow(documentIdQuerySchema, request.query);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    // Any member may delete a document — same org-level, not role-gated
    // MVP posture as document upload/KB creation (see this file's
    // POST /documents/:id/complete and knowledge-bases.ts's POST /kb).
    // Only KB-level PATCH/DELETE, which affects every document inside
    // it at once, requires ADMIN.
    await requireMembership(request, input.organizationId, userId);

    const document = await withTenantTransaction(input.organizationId, async (tx) => {
      // Atomic, conditional transition — updateMany's WHERE (not just a
      // separate findUnique + update) is what makes this race-safe: two
      // concurrent DELETE calls can't both "win" and each redundantly
      // touch S3/DocumentChunk, because only the request whose UPDATE
      // actually matches a still-non-DELETED row proceeds past this
      // point. The other gets count 0 and a 404, same as if it had
      // arrived a moment later and found nothing left to delete.
      const result = await tx.document.updateMany({
        where: { id: documentId, status: { not: "DELETED" } },
        data: { status: "DELETED", deletedAt: new Date() },
      });
      if (result.count === 0) {
        throw ApiError.notFound("Document not found");
      }

      // Vectors: no audit value in keeping embeddings around once their
      // source document is gone — hard-deleted here, unlike the Document
      // row itself (soft-deleted above) or the storage object (deleted
      // below, after this transaction commits).
      await tx.documentChunk.deleteMany({ where: { documentId } });

      return tx.document.findUniqueOrThrow({ where: { id: documentId } });
    });

    // Best-effort, after the DB truth commits — same ordering principle
    // as DELETE /kb/:id's synchronous path: deleteObjects treats a
    // missing key as success (S3's own semantics), so this is safe to
    // retry if it ever needs to be, and never leaves the DB claiming a
    // deletion that didn't actually happen.
    await deleteObjects([document.storageKey]);

    reply.status(204).send();
  });

  app.post(
    "/documents/:id/retry",
    { preHandler: requireAuth, bodyLimit: DOCUMENT_METADATA_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const { id: documentId } = request.params as { id: string };
      const input = parseOrThrow(retryDocumentSchema, request.body);
      const userId = request.userId;
      if (!userId) throw ApiError.unauthorized();

      await requireMembership(request, input.organizationId, userId);
      await checkIngestionRateLimit(input.organizationId, reply);
      // Same real embedding cost as the original POST /complete — a
      // retry re-runs the whole pipeline from extract-text, so it's
      // subject to the same daily ceiling, not a way around it.
      await checkDocumentQuota(input.organizationId, reply);

      const updated = await withTenantTransaction(input.organizationId, async (tx) => {
        // Atomic, conditional transition — same reasoning as DELETE
        // above: updateMany's WHERE (id AND status: FAILED) is what
        // prevents two concurrent retry calls from both transitioning
        // and both enqueueing a flow for the same document.
        const result = await tx.document.updateMany({
          where: { id: documentId, status: "FAILED" },
          data: { status: "QUEUED", failureReason: null, retryCount: { increment: 1 } },
        });

        if (result.count === 0) {
          // Distinguish "doesn't exist" from "exists but isn't FAILED"
          // for an accurate error — this read is inside the same
          // transaction, so it sees a consistent snapshot.
          const existing = await tx.document.findUnique({ where: { id: documentId } });
          if (!existing) {
            throw ApiError.notFound("Document not found");
          }
          throw ApiError.conflict(
            `Cannot retry a document in status ${existing.status} — only a document in FAILED can be retried`,
          );
        }

        return tx.document.findUniqueOrThrow({ where: { id: documentId } });
      });

      // Enqueued after the QUEUED transition commits, not before — same
      // ordering principle as POST /complete. attempt: updated.retryCount
      // (already incremented above) gives this retry's BullMQ jobs their
      // own jobId namespace, distinct from the original attempt's (or an
      // earlier retry's) now-terminal jobs — see ingestion-flow.ts.
      //
      // Not duplicating chunks: chunk-text upserts on (documentId,
      // chunkIndex), and embed-chunks only ever calls the embedding
      // provider for chunks that don't already have one (see that
      // processor's own idempotency design) — re-running the pipeline
      // from extract-text is always safe to do in full, never
      // re-creates rows or re-bills work a prior attempt already paid
      // for and persisted.
      await enqueueDocumentIngestion({
        documentId,
        organizationId: input.organizationId,
        knowledgeBaseId: updated.knowledgeBaseId,
        attempt: updated.retryCount,
      });

      reply.send(updated);
    },
  );
}
