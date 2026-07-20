/**
 * Unit tests for deleteObjects's partial-failure detection specifically —
 * mocks s3.send rather than hitting real MinIO. Mirrors
 * apps/api/src/lib/storage.test.ts's own copy of these tests (see that
 * file's doc comment for why this is unit-tested rather than exercised
 * against a real backend, and why apps/api and apps/worker each have
 * their own duplicated deleteObjects/S3 client in the first place).
 */
import type { DeleteObjectsCommandOutput } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { deleteObjects, s3 } from "./storage.js";

function fakeOutput(overrides: Partial<DeleteObjectsCommandOutput>): DeleteObjectsCommandOutput {
  return { $metadata: {}, ...overrides };
}

describe("deleteObjects", () => {
  it("throws when S3 reports a partial per-key failure, even though the call itself succeeded (HTTP 200)", async () => {
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
