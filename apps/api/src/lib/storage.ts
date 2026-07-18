import { randomUUID } from "node:crypto";

import { CreateBucketCommand, DeleteObjectsCommand, HeadBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

import { env } from "../env.js";

// Long enough that a slow upload over a real connection doesn't get cut
// off, short enough to bound how long a leaked presigned URL stays valid.
const PRESIGN_TTL_SECONDS = 15 * 60;

export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

/**
 * Dev/test convenience only — real S3/R2 buckets are provisioned out of
 * band (see docs/implementation-plan.md, RAAS-13). Idempotent: swallows
 * "already exists", so it's safe to call unconditionally on every boot.
 */
export async function ensureBucketExists(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    return;
  } catch {
    // Falls through to create — HeadBucket failing just means "not found
    // (or not reachable yet)", handled below rather than here so a real
    // creation failure (e.g. permissions) still surfaces.
  }

  try {
    await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
      throw err;
    }
  }
}

/** Namespaced by org/KB so listing/cleanup can be scoped without a DB round-trip. */
export function buildStorageKey(organizationId: string, knowledgeBaseId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-150);
  return `${organizationId}/${knowledgeBaseId}/${randomUUID()}-${safeName}`;
}

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
  expiresAt: Date;
}

/**
 * Presigned POST, not a presigned PUT — deliberately: a PUT URL's SigV4
 * query-string signature has no way to bind Content-Length, so nothing
 * stops a client from PUTting arbitrarily more bytes than it declared at
 * presign time (this was the actual gap this function used to leave
 * open). An S3 POST policy's `content-length-range` condition is
 * enforced by the storage backend itself, before the object is ever
 * created — verified empirically against real MinIO (not assumed from
 * docs): an out-of-range POST is rejected with a 400 EntityTooLarge and
 * no object is written at all. Same AWS SDK v3 POST-policy mechanism
 * works against real S3/R2 in staging/prod, only S3_ENDPOINT differs
 * (see env.ts).
 *
 * `maxSizeBytes` is the caller-declared sizeBytes from the presign
 * request (see POST /kb/:id/documents/presign), not the platform-wide
 * MAX_UPLOAD_SIZE_BYTES ceiling — binding the range to what THIS caller
 * actually claimed is what closes the "declares a small size, uploads
 * something bigger" gap specifically, not just the platform-wide one
 * (already enforced separately by presignDocumentSchema's own .max()).
 */
export async function createPresignedUpload(key: string, contentType: string, maxSizeBytes: number): Promise<PresignedUpload> {
  const { url, fields } = await createPresignedPost(s3, {
    Bucket: env.S3_BUCKET,
    Key: key,
    Conditions: [["content-length-range", 1, maxSizeBytes]],
    Fields: { "Content-Type": contentType },
    Expires: PRESIGN_TTL_SECONDS,
  });
  return { url, fields, expiresAt: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000) };
}

/**
 * Existence + actual size, in one HEAD call. The size half is the
 * "otherwise" backstop POST /documents/:id/complete relies on: the
 * content-length-range condition above is the primary defense (nothing
 * oversized should ever land in the bucket), but this is what catches it
 * independently if it somehow did anyway — a provider that doesn't honor
 * the policy, a misconfiguration, or bytes that reached this key by some
 * path other than the sanctioned presigned POST.
 */
export async function getObjectMetadata(key: string): Promise<{ sizeBytes: number } | null> {
  try {
    const result = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return { sizeBytes: result.ContentLength ?? 0 };
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey") {
      return null;
    }
    throw err;
  }
}

/** Used by POST /documents/:id/complete to verify the client actually uploaded the bytes. */
export async function objectExists(key: string): Promise<boolean> {
  return (await getObjectMetadata(key)) !== null;
}

// S3's DeleteObjects accepts at most 1000 keys per call.
const DELETE_BATCH_SIZE = 1000;

/**
 * Batch-deletes every key given, chunked into groups of 1000 (S3's own
 * per-call limit). Used by DELETE /kb/:id's synchronous (small-KB) path —
 * see apps/worker's cleanup-knowledge-base processor for the async
 * (large-KB) equivalent. Deleting a key that doesn't exist is not an
 * error (S3's own semantics), which is what makes retrying this safe.
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
    if (batch.length === 0) continue;
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: env.S3_BUCKET,
        Delete: { Objects: batch.map((key) => ({ Key: key })) },
      }),
    );
  }
}
