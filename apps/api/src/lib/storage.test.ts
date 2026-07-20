/**
 * Unit tests for deleteObjects's partial-failure detection specifically —
 * mocks s3.send rather than hitting real MinIO, since the scenario being
 * tested (S3's DeleteObjects API reporting SOME keys as failed inside an
 * otherwise-200 response) isn't something a real local S3-compatible
 * backend can be made to reproduce on demand. Every other storage.ts
 * behavior (real uploads/deletes/existence checks) is already covered by
 * the real-MinIO integration tests in routes/documents.test.ts and
 * routes/knowledge-bases.test.ts.
 */
import type { DeleteObjectsCommandOutput } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { deleteObjects, s3 } from "./storage.js";

function fakeOutput(overrides: Partial<DeleteObjectsCommandOutput>): DeleteObjectsCommandOutput {
  return { $metadata: {}, ...overrides };
}

describe("deleteObjects", () => {
  it("throws when S3 reports a partial per-key failure, even though the call itself succeeded (HTTP 200)", async () => {
    // DeleteObjectsCommand never rejects for a partial failure — S3
    // reports it in the response body's Errors array instead. Without
    // checking that array (the bug this test guards against), a caller
    // would believe this fully succeeded and never retry the object that
    // actually failed, silently orphaning it.
    const sendSpy = vi.spyOn(s3, "send").mockResolvedValueOnce(
      fakeOutput({
        Deleted: [{ Key: "org/kb/ok.pdf" }],
        Errors: [{ Key: "org/kb/broken.pdf", Code: "AccessDenied", Message: "Access Denied" }],
      }) as never,
    );

    await expect(deleteObjects(["org/kb/ok.pdf", "org/kb/broken.pdf"])).rejects.toThrow(/broken\.pdf.*AccessDenied/);

    sendSpy.mockRestore();
  });

  it("does not throw when every key in the batch deletes cleanly (no Errors array)", async () => {
    const sendSpy = vi.spyOn(s3, "send").mockResolvedValueOnce(fakeOutput({ Deleted: [{ Key: "org/kb/ok.pdf" }] }) as never);

    await expect(deleteObjects(["org/kb/ok.pdf"])).resolves.toBeUndefined();

    sendSpy.mockRestore();
  });

  it("does not throw when Errors is present but empty", async () => {
    const sendSpy = vi.spyOn(s3, "send").mockResolvedValueOnce(fakeOutput({ Deleted: [{ Key: "org/kb/ok.pdf" }], Errors: [] }) as never);

    await expect(deleteObjects(["org/kb/ok.pdf"])).resolves.toBeUndefined();

    sendSpy.mockRestore();
  });

  it("is a no-op for an empty key list — never calls S3 at all", async () => {
    const sendSpy = vi.spyOn(s3, "send");

    await deleteObjects([]);

    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it("propagates a genuine call-level rejection (e.g. a network error) unmodified", async () => {
    const sendSpy = vi.spyOn(s3, "send").mockRejectedValueOnce(new Error("simulated network failure"));

    await expect(deleteObjects(["org/kb/ok.pdf"])).rejects.toThrow("simulated network failure");

    sendSpy.mockRestore();
  });
});
