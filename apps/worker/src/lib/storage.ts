import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

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
