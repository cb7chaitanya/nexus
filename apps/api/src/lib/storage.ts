import { randomUUID } from "node:crypto";

import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

export async function createPresignedUploadUrl(
  key: string,
  contentType: string,
): Promise<{ url: string; expiresAt: Date }> {
  const command = new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType });
  const url = await getSignedUrl(s3, command, { expiresIn: PRESIGN_TTL_SECONDS });
  return { url, expiresAt: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000) };
}

/** Used by POST /documents/:id/complete to verify the client actually uploaded the bytes. */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return true;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey") {
      return false;
    }
    throw err;
  }
}
