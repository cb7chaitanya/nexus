-- Online-migration-safe: add nullable, backfill, then constrain (see
-- docs/decisions.md's migration discipline note) — never a bare
-- NOT NULL ADD COLUMN against a populated table without a default.
-- No DB-level default afterward: @updatedAt is a purely app-level Prisma
-- concern (set on every .update() call), same as every other timestamp
-- column in this schema.
ALTER TABLE "Document" ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "Document" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;

ALTER TABLE "Document" ALTER COLUMN "updatedAt" SET NOT NULL;
