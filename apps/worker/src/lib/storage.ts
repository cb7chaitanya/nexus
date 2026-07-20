import { DeleteObjectsCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { env } from "../env.js";

// Separate S3Client instance from apps/api's (see apps/api/src/lib/storage.ts)
// — each process owns its own client, same convention as this repo's Redis
// connections. The worker only ever reads objects (extract-text downloads
// the uploaded file); it never presigns or creates buckets, that's the
// API's job.
export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

export async function downloadObject(key: string): Promise<Buffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) {
    throw new Error(`downloadObject: no body returned for key ${key}`);
  }
  return Buffer.from(bytes);
}

// S3's DeleteObjects accepts at most 1000 keys per call.
const DELETE_BATCH_SIZE = 1000;

/**
 * Batch-deletes every key given, chunked into groups of 1000. Used by the
 * cleanup-knowledge-base and cleanup-document-storage processors —
 * mirrors apps/api's own lib/storage.ts's deleteObjects exactly (each
 * process owns its own S3 client, same convention as this repo's Redis
 * connections, so the function is duplicated rather than shared).
 * Deleting a key that doesn't exist is not an error (S3's own
 * semantics), which is what makes retrying a failed cleanup job safe: a
 * retry re-lists every document and re-attempts deleting all of them,
 * including ones a prior attempt already removed.
 *
 * DeleteObjectsCommand returns HTTP 200 even when SOME keys in the batch
 * failed — S3 reports those individually in the response body's `Errors`
 * array rather than rejecting the call. Checking it here turns a
 * partial, silently-ignored failure into a thrown error, which is what
 * lets BullMQ's own retry (attempts/backoff, set at enqueue time) engage
 * instead of the job reporting success when it wasn't fully done.
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
    if (batch.length === 0) continue;
    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: env.S3_BUCKET,
        Delete: { Objects: batch.map((key) => ({ Key: key })) },
      }),
    );
    if (result.Errors && result.Errors.length > 0) {
      const summary = result.Errors.map((e) => `${e.Key}: ${e.Code} ${e.Message ?? ""}`.trim()).join("; ");
      throw new Error(`deleteObjects: ${result.Errors.length} of ${batch.length} object(s) failed to delete: ${summary}`);
    }
  }
}
