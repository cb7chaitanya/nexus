import { ApiError, completeDocumentSchema, parseOrThrow } from "@raas/shared";
import { withTenantTransaction } from "@raas/db";
import type { FastifyInstance } from "fastify";

import { requireMembership } from "../lib/membership.js";
import { objectExists } from "../lib/storage.js";
import { requireAuth } from "../plugins/auth-guard.js";

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/documents/:id/complete", { preHandler: requireAuth }, async (request, reply) => {
    const { id: documentId } = request.params as { id: string };
    const input = parseOrThrow(completeDocumentSchema, request.body);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    await requireMembership(input.organizationId, userId);

    // Ownership: the document is looked up scoped to this org's tenant
    // context, so a documentId belonging to another org is indistinguishable
    // from a nonexistent one — RLS enforces this, not an app-level owner
    // check.
    const document = await withTenantTransaction(input.organizationId, (tx) =>
      tx.document.findUnique({ where: { id: documentId } }),
    );
    if (!document) {
      throw ApiError.notFound("Document not found");
    }

    // Status transition: only a document still awaiting its upload can be
    // completed — this call is not a generic "requeue" endpoint.
    if (document.status !== "PENDING_UPLOAD") {
      throw ApiError.conflict(
        `Cannot complete a document in status ${document.status} — only a document in PENDING_UPLOAD can be completed`,
      );
    }

    // Object exists: the client's claim that it finished the S3/R2 PUT is
    // verified against the bucket, not trusted.
    const uploaded = await objectExists(document.storageKey);
    if (!uploaded) {
      throw ApiError.conflict(
        "No uploaded object found for this document — the upload may not have completed",
      );
    }

    // Enqueueing the ingestion job is stubbed until extraction exists (see
    // docs/implementation-plan.md, RAAS-19) — this only records that the
    // document is ready to be picked up.
    const updated = await withTenantTransaction(input.organizationId, (tx) =>
      tx.document.update({ where: { id: documentId }, data: { status: "QUEUED" } }),
    );

    reply.send(updated);
  });
}
