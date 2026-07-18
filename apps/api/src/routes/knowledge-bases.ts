import {
  ApiError,
  createKnowledgeBaseSchema,
  knowledgeBaseIdQuerySchema,
  listDocumentsQuerySchema,
  listKnowledgeBasesQuerySchema,
  parseOrThrow,
  presignDocumentSchema,
  updateKnowledgeBaseSchema,
} from "@raas/shared";
import { withTenantTransaction } from "@raas/db";
import type { FastifyInstance } from "fastify";

import { env } from "../env.js";
import { DOCUMENT_METADATA_BODY_LIMIT_BYTES } from "../lib/body-limits.js";
import { enqueueKnowledgeBaseCleanup } from "../lib/kb-cleanup.js";
import { requireMembership } from "../lib/membership.js";
import { paginate } from "../lib/pagination.js";
import { checkIngestionRateLimit } from "../lib/rate-limit.js";
import { hasAtLeastRole } from "../lib/roles.js";
import { buildStorageKey, createPresignedUpload, deleteObjects } from "../lib/storage.js";
import { requireAuth } from "../plugins/auth-guard.js";

/** ACTIVE-only, 404 otherwise — a KB mid-async-deletion (see DELETE
 * /kb/:id) is treated as already gone by every read/write path below,
 * even though its rows still exist until the worker finishes. */
function assertActiveKnowledgeBase(knowledgeBase: { status: string } | null): void {
  if (!knowledgeBase || knowledgeBase.status !== "ACTIVE") {
    throw ApiError.notFound("Knowledge base not found");
  }
}

export async function knowledgeBaseRoutes(app: FastifyInstance): Promise<void> {
  app.post("/kb", { preHandler: requireAuth }, async (request, reply) => {
    const input = parseOrThrow(createKnowledgeBaseSchema, request.body);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    // Any member may create a KB — MVP access is org-level, not role-gated
    // (see architecture.md's "Document permissions" section).
    await requireMembership(request, input.organizationId, userId);
    await checkIngestionRateLimit(input.organizationId, reply);

    const knowledgeBase = await withTenantTransaction(input.organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId: input.organizationId,
          name: input.name,
          embeddingProvider: input.embeddingProvider,
          embeddingModel: input.embeddingModel,
          embeddingDim: input.embeddingDim,
        },
      }),
    );

    reply.status(201).send(knowledgeBase);
  });

  app.get("/kb", { preHandler: requireAuth }, async (request, reply) => {
    const input = parseOrThrow(listKnowledgeBasesQuerySchema, request.query);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    await requireMembership(request, input.organizationId, userId);

    // Sort order (asc, oldest first) is unchanged from before pagination
    // was added — cursor pagination is additive on top of it, not a
    // reordering. status: ACTIVE excludes a KB mid-async-deletion (see
    // DELETE /kb/:id) — it's gone from the caller's perspective the
    // moment DELETE returns, regardless of whether the cleanup worker has
    // actually finished yet.
    const knowledgeBases = await withTenantTransaction(input.organizationId, (tx) =>
      tx.knowledgeBase.findMany({
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
        take: input.limit,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      }),
    );

    reply.send(paginate(knowledgeBases, input.limit));
  });

  app.get("/kb/:id/documents", { preHandler: requireAuth }, async (request, reply) => {
    const { id: knowledgeBaseId } = request.params as { id: string };
    const input = parseOrThrow(listDocumentsQuerySchema, request.query);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    await requireMembership(request, input.organizationId, userId);

    const documents = await withTenantTransaction(input.organizationId, async (tx) => {
      const knowledgeBase = await tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
      assertActiveKnowledgeBase(knowledgeBase);

      // DELETED excluded — same "invisible in listings, still fetchable
      // by id" treatment as GET /documents/:id gives it (see
      // documents.ts). FAILED is deliberately still shown: a caller
      // needs to see it to know it exists and can be retried.
      return tx.document.findMany({
        where: { knowledgeBaseId, status: { not: "DELETED" } },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
    });

    reply.send(paginate(documents, input.limit));
  });

  app.post(
    "/kb/:id/documents/presign",
    // Tighter than the app-wide default (lib/body-limits.ts) — this
    // route's whole body is a file name, a mime type, an org id, and a
    // byte count, nowhere near the global ceiling.
    { preHandler: requireAuth, bodyLimit: DOCUMENT_METADATA_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const { id: knowledgeBaseId } = request.params as { id: string };
      const input = parseOrThrow(presignDocumentSchema, request.body);
      const userId = request.userId;
      if (!userId) throw ApiError.unauthorized();

      await requireMembership(request, input.organizationId, userId);
      await checkIngestionRateLimit(input.organizationId, reply);

      // Confirming the KB exists AND belongs to this org, then creating
      // the PENDING_UPLOAD Document row, happen in the same tenant-scoped
      // transaction — RLS is what actually enforces "ownership" here: a
      // knowledgeBaseId from a different org simply won't be found.
      const document = await withTenantTransaction(input.organizationId, async (tx) => {
        const knowledgeBase = await tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
        assertActiveKnowledgeBase(knowledgeBase);

        const storageKey = buildStorageKey(input.organizationId, knowledgeBaseId, input.fileName);

        return tx.document.create({
          data: {
            organizationId: input.organizationId,
            knowledgeBaseId,
            fileName: input.fileName,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            storageKey,
            uploadedById: userId,
          },
        });
      });

      // maxSizeBytes is THIS caller's own declared input.sizeBytes, not
      // the platform-wide MAX_UPLOAD_SIZE_BYTES ceiling — see
      // createPresignedUpload's doc comment for why that's the whole
      // point (binds the storage-level enforcement to what was actually
      // declared, not just the platform maximum).
      const { url, fields, expiresAt } = await createPresignedUpload(document.storageKey, document.mimeType, input.sizeBytes);

      // Presigned POST, not a presigned PUT (see createPresignedUpload) —
      // the client must POST a multipart/form-data request to `uploadUrl`
      // with every entry of `uploadFields` included as its own form
      // field, plus the file itself under a field named "file".
      reply.status(201).send({ document, uploadUrl: url, uploadFields: fields, uploadUrlExpiresAt: expiresAt });
    },
  );

  app.get("/kb/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id: knowledgeBaseId } = request.params as { id: string };
    const input = parseOrThrow(knowledgeBaseIdQuerySchema, request.query);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    await requireMembership(request, input.organizationId, userId);

    // Stats computed alongside the KB itself, in the same tenant-scoped
    // transaction — doc count, chunk count, and total stored bytes are
    // exactly what architecture.md's "KB details + stats" describes.
    const result = await withTenantTransaction(input.organizationId, async (tx) => {
      const knowledgeBase = await tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
      assertActiveKnowledgeBase(knowledgeBase);

      // DELETED documents have had their storage object and chunks
      // already removed (see DELETE /documents/:id) — counting them here
      // would overstate both documentCount and storageBytes for
      // something that no longer actually occupies either. chunkCount
      // needs no equivalent filter: a DELETED document's chunks are
      // hard-deleted, not soft, so they're simply absent already.
      const notDeleted = { knowledgeBaseId, status: { not: "DELETED" as const } };
      const [documentCount, chunkCount, storageAggregate] = await Promise.all([
        tx.document.count({ where: notDeleted }),
        tx.documentChunk.count({ where: { knowledgeBaseId } }),
        tx.document.aggregate({ where: notDeleted, _sum: { sizeBytes: true } }),
      ]);

      return {
        ...knowledgeBase,
        stats: {
          documentCount,
          chunkCount,
          storageBytes: storageAggregate._sum.sizeBytes ?? 0,
        },
      };
    });

    reply.send(result);
  });

  app.patch("/kb/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id: knowledgeBaseId } = request.params as { id: string };
    const input = parseOrThrow(updateKnowledgeBaseSchema, request.body);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    // Mutating a shared org resource — same ADMIN-or-higher bar as
    // organizations.ts's PATCH/invite routes, applied here inline
    // (requireRole's preHandler form reads organizationId off a :id URL
    // param, which doesn't fit — /kb/:id's organizationId comes from the
    // body instead, same as every other KB route).
    const role = await requireMembership(request, input.organizationId, userId);
    if (!hasAtLeastRole(role, "ADMIN")) {
      throw ApiError.forbidden("This action requires the ADMIN role or higher");
    }

    const updated = await withTenantTransaction(input.organizationId, async (tx) => {
      const existing = await tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
      assertActiveKnowledgeBase(existing);

      // embeddingProvider/embeddingModel/embeddingDim are immutable —
      // see updateKnowledgeBaseSchema's own comment for why; only
      // name/description are ever in `input`.
      return tx.knowledgeBase.update({
        where: { id: knowledgeBaseId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      });
    });

    reply.send(updated);
  });

  app.delete("/kb/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id: knowledgeBaseId } = request.params as { id: string };
    const input = parseOrThrow(knowledgeBaseIdQuerySchema, request.query);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    const role = await requireMembership(request, input.organizationId, userId);
    if (!hasAtLeastRole(role, "ADMIN")) {
      throw ApiError.forbidden("This action requires the ADMIN role or higher");
    }

    // Chunk count decides sync vs. async (see env.ts's
    // KB_DELETION_ASYNC_CHUNK_THRESHOLD): below it, the cascade delete
    // (KnowledgeBase -> Document -> DocumentChunk, all onDelete: Cascade)
    // plus S3 cleanup happen inline and this returns 204. At or above it,
    // this only flips status to DELETING (making the KB invisible to
    // every other route immediately) and hands the actual row/S3 cleanup
    // to an async worker job — see lib/kb-cleanup.ts and apps/worker's
    // cleanup-knowledge-base processor.
    const outcome = await withTenantTransaction(input.organizationId, async (tx) => {
      const existing = await tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
      assertActiveKnowledgeBase(existing);

      const chunkCount = await tx.documentChunk.count({ where: { knowledgeBaseId } });

      if (chunkCount > env.KB_DELETION_ASYNC_CHUNK_THRESHOLD) {
        await tx.knowledgeBase.update({ where: { id: knowledgeBaseId }, data: { status: "DELETING" } });
        return { async: true as const, storageKeys: [] as string[] };
      }

      // Storage keys are read BEFORE the cascade delete — once the
      // Document rows are gone, so is the only record of which S3
      // objects belonged to this KB. DELETED documents excluded: their
      // object was already removed by DELETE /documents/:id, so
      // re-deleting it here would just be redundant (harmless, since S3
      // treats deleting a missing key as success, but pointless).
      const documents = await tx.document.findMany({ where: { knowledgeBaseId, status: { not: "DELETED" } }, select: { storageKey: true } });
      await tx.knowledgeBase.delete({ where: { id: knowledgeBaseId } });
      return { async: false as const, storageKeys: documents.map((d) => d.storageKey) };
    });

    if (outcome.async) {
      await enqueueKnowledgeBaseCleanup({ organizationId: input.organizationId, knowledgeBaseId });
      reply.status(202).send({ id: knowledgeBaseId, status: "DELETING" });
      return;
    }

    // Best-effort, after the DB truth (the KB and its rows are already
    // gone) — same ordering principle as enqueueDocumentIngestion running
    // only after its own DB transition commits.
    await deleteObjects(outcome.storageKeys);
    reply.status(204).send();
  });
}
