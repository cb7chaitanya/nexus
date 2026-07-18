import { describe, expect, it } from "vitest";

import { createJobLogger } from "./job-logger.js";

/**
 * createJobLogger is the single chokepoint every processor
 * (extract-text/chunk-text/embed-chunks/process-document/
 * sweep-stuck-documents) calls to build its per-job logger — see each
 * processor's own `const log = createJobLogger({ jobId: job.id, ... })`
 * line. Testing it directly via pino's real .bindings() API (the same
 * approach apps/api's request-logging tests use for request.log) proves
 * the actual mechanism every worker log line goes through, without
 * needing to intercept stdout/the pino-pretty transport.
 */
describe("createJobLogger", () => {
  it("binds service, jobId, organizationId, and documentId together", () => {
    const log = createJobLogger({ jobId: "job-123", organizationId: "org-456", documentId: "doc-789" });

    expect(log.bindings()).toEqual({ service: "worker", jobId: "job-123", organizationId: "org-456", documentId: "doc-789" });
  });

  it("binds requestId alongside jobId/organizationId/documentId, for correlation back to the originating HTTP request", () => {
    const log = createJobLogger({ jobId: "job-123", organizationId: "org-456", documentId: "doc-789", requestId: "req-abc" });

    expect(log.bindings()).toEqual({
      service: "worker",
      jobId: "job-123",
      organizationId: "org-456",
      documentId: "doc-789",
      requestId: "req-abc",
    });
  });

  it("binds knowledgeBaseId alongside every other job-context field", () => {
    const log = createJobLogger({
      jobId: "job-123",
      organizationId: "org-456",
      documentId: "doc-789",
      requestId: "req-abc",
      knowledgeBaseId: "kb-xyz",
    });

    expect(log.bindings()).toEqual({
      service: "worker",
      jobId: "job-123",
      organizationId: "org-456",
      documentId: "doc-789",
      requestId: "req-abc",
      knowledgeBaseId: "kb-xyz",
    });
  });

  it("omits fields that weren't provided rather than binding them as undefined", () => {
    // Sweep's job-level logger only knows jobId up front — organizationId
    // and documentId are added per document via .child() inside the loop
    // (see sweep-stuck-documents.ts). Confirms the base call doesn't
    // pollute bindings with undefined placeholders for those fields.
    const log = createJobLogger({ jobId: "sweep-job-1" });

    expect(log.bindings()).toEqual({ service: "worker", jobId: "sweep-job-1" });
    expect("organizationId" in log.bindings()).toBe(false);
    expect("documentId" in log.bindings()).toBe(false);
  });

  it("accumulates organizationId/documentId via .child(), matching sweep-stuck-documents.ts's per-document pattern", () => {
    const jobLog = createJobLogger({ jobId: "sweep-job-2" });
    const docLog = jobLog.child({ organizationId: "org-a", documentId: "doc-a" });

    expect(docLog.bindings()).toEqual({ service: "worker", jobId: "sweep-job-2", organizationId: "org-a", documentId: "doc-a" });
    // The job-level logger itself is untouched by the child's bindings.
    expect(jobLog.bindings()).toEqual({ service: "worker", jobId: "sweep-job-2" });
  });

  it("only ever binds the documented job-context fields — no room for a content/text field to slip in", () => {
    const log = createJobLogger({ jobId: "job-1", organizationId: "org-1", documentId: "doc-1" });

    const log2 = createJobLogger({ jobId: "job-1", organizationId: "org-1", documentId: "doc-1", requestId: "req-1", knowledgeBaseId: "kb-1" });
    expect(Object.keys(log2.bindings()).sort()).toEqual(["documentId", "jobId", "knowledgeBaseId", "organizationId", "requestId", "service"]);
    expect(Object.keys(log.bindings()).sort()).toEqual(["documentId", "jobId", "organizationId", "service"]);
  });
});
