import {
  ApiError,
  createKnowledgeBaseSchema,
  listDocumentsQuerySchema,
  listKnowledgeBasesQuerySchema,
  parseOrThrow,
  presignDocumentSchema,
} from "@raas/shared";
import { withTenantTransaction } from "@raas/db";
import type { FastifyInstance } from "fastify";

import { requireMembership } from "../lib/membership.js";
import { paginate } from "../lib/pagination.js";
import { buildStorageKey, createPresignedUploadUrl } from "../lib/storage.js";
import { requireAuth } from "../plugins/auth-guard.js";

export async function knowledgeBaseRoutes(app: FastifyInstance): Promise<void> {
  app.post("/kb", { preHandler: requireAuth }, async (request, reply) => {
    const input = parseOrThrow(createKnowledgeBaseSchema, request.body);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    // Any member may create a KB — MVP access is org-level, not role-gated
    // (see architecture.md's "Document permissions" section).
    await requireMembership(input.organizationId, userId);

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

    await requireMembership(input.organizationId, userId);

    // Sort order (asc, oldest first) is unchanged from before pagination
    // was added — cursor pagination is additive on top of it, not a
    // reordering.
    const knowledgeBases = await withTenantTransaction(input.organizationId, (tx) =>
      tx.knowledgeBase.findMany({
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

    await requireMembership(input.organizationId, userId);

    const documents = await withTenantTransaction(input.organizationId, async (tx) => {
      const knowledgeBase = await tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
      if (!knowledgeBase) {
        throw ApiError.notFound("Knowledge base not found");
      }

      return tx.document.findMany({
        where: { knowledgeBaseId },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
    });

    reply.send(paginate(documents, input.limit));
  });

  app.post("/kb/:id/documents/presign", { preHandler: requireAuth }, async (request, reply) => {
    const { id: knowledgeBaseId } = request.params as { id: string };
    const input = parseOrThrow(presignDocumentSchema, request.body);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    await requireMembership(input.organizationId, userId);

    // Confirming the KB exists AND belongs to this org, then creating the
    // PENDING_UPLOAD Document row, happen in the same tenant-scoped
    // transaction — RLS is what actually enforces "ownership" here: a
    // knowledgeBaseId from a different org simply won't be found.
    const document = await withTenantTransaction(input.organizationId, async (tx) => {
      const knowledgeBase = await tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId } });
      if (!knowledgeBase) {
        throw ApiError.notFound("Knowledge base not found");
      }

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

    const { url, expiresAt } = await createPresignedUploadUrl(document.storageKey, document.mimeType);

    reply.status(201).send({ document, uploadUrl: url, uploadUrlExpiresAt: expiresAt });
  });
}
