/**
 * toSafeFailureReason is pure — no infra needed, so most of this file is a
 * fast unit-test suite over the allowlist logic itself. One integration
 * test at the bottom proves failDocument actually routes through it when
 * writing to Postgres (real Postgres/RLS, same convention as this
 * package's other processor tests), not just that the pure function is
 * correct in isolation.
 *
 * Prerequisites (failDocument test only): docker compose up -d, migrations
 * applied.
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { ApiError } from "@raas/shared";
import { UnrecoverableError } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ScannedDocumentError } from "./extract-pdf.js";
import { DocumentValidationError, failDocument, toSafeFailureReason } from "./job-failure.js";

const GENERIC_MESSAGE = "Document processing failed. Please contact support.";

describe("toSafeFailureReason", () => {
  it("passes through ScannedDocumentError's message unmodified", () => {
    expect(toSafeFailureReason(new ScannedDocumentError())).toBe("scanned document, OCR not supported");
  });

  it("passes through DocumentValidationError's message unmodified", () => {
    const err = new DocumentValidationError('Unsupported file type "image/png" — only application/pdf is supported');
    expect(toSafeFailureReason(err)).toBe('Unsupported file type "image/png" — only application/pdf is supported');
  });

  it("still recognizes a DocumentValidationError as an UnrecoverableError (bullmq's own instanceof check)", () => {
    const err = new DocumentValidationError("document produced no extractable text chunks");
    expect(err).toBeInstanceOf(UnrecoverableError);
  });

  it("passes through ApiError's message unmodified — e.g. a daily budget rejection", () => {
    const err = ApiError.rateLimited("Organization org-123 has exceeded its daily embedding token budget");
    expect(toSafeFailureReason(err)).toBe("Organization org-123 has exceeded its daily embedding token budget");
  });

  it("collapses a plain UnrecoverableError (internal plumbing, not document-content) to the generic message", () => {
    const err = new UnrecoverableError("chunk-text job abc123 has no parent — it must run as part of the process-document flow");
    expect(toSafeFailureReason(err)).toBe(GENERIC_MESSAGE);
  });

  it("collapses a generic Error to the generic message, never leaking its own text", () => {
    const err = new Error("connect ECONNREFUSED 10.0.4.12:5432");
    expect(toSafeFailureReason(err)).toBe(GENERIC_MESSAGE);
  });

  it("collapses an S3-SDK-shaped error (name/$metadata, no useful .message safety) to the generic message", () => {
    const s3Err = Object.assign(new Error("The specified bucket does not exist"), {
      name: "NoSuchBucket",
      $metadata: { httpStatusCode: 404, requestId: "s3-internal-request-id" },
    });
    expect(toSafeFailureReason(s3Err)).toBe(GENERIC_MESSAGE);
  });

  it("collapses a non-Error thrown value to the generic message", () => {
    expect(toSafeFailureReason("a raw string throw")).toBe(GENERIC_MESSAGE);
    expect(toSafeFailureReason(undefined)).toBe(GENERIC_MESSAGE);
    expect(toSafeFailureReason({ some: "object" })).toBe(GENERIC_MESSAGE);
  });

  it("never lets the generic message accidentally contain a database URL, S3 detail, or stack trace", () => {
    const err = new Error("password authentication failed for user \"raas_app\" at postgres://raas:secret@db:5432/raas");
    err.stack = `Error: password authentication failed\n    at Connection.connect (/app/node_modules/pg/lib/connection.js:1:1)`;
    const reason = toSafeFailureReason(err);
    expect(reason).toBe(GENERIC_MESSAGE);
    expect(reason).not.toContain("postgres://");
    expect(reason).not.toContain("secret");
    expect(reason).not.toContain("node_modules");
  });
});

describe("failDocument (real Postgres)", () => {
  const suffix = randomUUID().slice(0, 8);
  let organizationId: string;
  let knowledgeBaseId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Job Failure Org ${suffix}`, slug: `job-failure-${suffix}` },
    });
    organizationId = org.id;
    const kb = await withTenantTransaction(organizationId, (tx) =>
      tx.knowledgeBase.create({
        data: { organizationId, name: "Job Failure KB", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: 1536 },
      }),
    );
    knowledgeBaseId = kb.id;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
  });

  it("persists the sanitized reason, not the raw error message, for a generic internal failure", async () => {
    const document = await withTenantTransaction(organizationId, (tx) =>
      tx.document.create({
        data: {
          organizationId,
          knowledgeBaseId,
          fileName: "test.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storageKey: `${organizationId}/${knowledgeBaseId}/${randomUUID()}-test.pdf`,
          status: "PROCESSING",
        },
      }),
    );

    await failDocument(organizationId, document.id, new Error("connect ECONNREFUSED 10.0.4.12:5432"));

    const updated = await withTenantTransaction(organizationId, (tx) => tx.document.findUniqueOrThrow({ where: { id: document.id } }));
    expect(updated.status).toBe("FAILED");
    expect(updated.failureReason).toBe(GENERIC_MESSAGE);
  });

  it("persists a DocumentValidationError's message as-is — it's meant to be read by the tenant", async () => {
    const document = await withTenantTransaction(organizationId, (tx) =>
      tx.document.create({
        data: {
          organizationId,
          knowledgeBaseId,
          fileName: "image.png",
          mimeType: "image/png",
          sizeBytes: 1024,
          storageKey: `${organizationId}/${knowledgeBaseId}/${randomUUID()}-image.png`,
          status: "PROCESSING",
        },
      }),
    );

    await failDocument(
      organizationId,
      document.id,
      new DocumentValidationError('Unsupported file type "image/png" — only application/pdf is supported'),
    );

    const updated = await withTenantTransaction(organizationId, (tx) => tx.document.findUniqueOrThrow({ where: { id: document.id } }));
    expect(updated.failureReason).toBe('Unsupported file type "image/png" — only application/pdf is supported');
  });
});
