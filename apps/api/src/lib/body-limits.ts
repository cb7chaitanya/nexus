/**
 * Explicit Fastify body-size ceilings — previously this app relied on
 * Fastify's own undocumented 1 MiB default (an implicit default is not a
 * decision). No route in this API ever receives raw file bytes: document
 * uploads go directly from the client to S3/R2 via a presigned PUT URL
 * (see lib/storage.ts's createPresignedUploadUrl), never through
 * Fastify's body parser — every request body here is small, structured
 * JSON (auth credentials, org/KB metadata, a chat message capped at 4000
 * characters by chatSchema).
 *
 * GLOBAL_BODY_LIMIT_BYTES is generous headroom over the largest real body
 * in this API (chat's ~4000-character message plus JSON overhead is a
 * few KB). DOCUMENT_METADATA_BODY_LIMIT_BYTES is tighter still, applied
 * to POST /kb/:id/documents/presign and POST /documents/:id/complete
 * specifically — their entire body is a file name, a mime type, an
 * organization id, and a byte-count number, none of which need anywhere
 * near the global ceiling.
 */
export const GLOBAL_BODY_LIMIT_BYTES = 256 * 1024; // 256 KiB
export const DOCUMENT_METADATA_BODY_LIMIT_BYTES = 16 * 1024; // 16 KiB
