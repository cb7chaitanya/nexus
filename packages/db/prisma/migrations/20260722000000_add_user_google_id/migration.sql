-- Nullable, no backfill needed — every existing row is a password
-- account with no Google identity yet. Postgres treats NULL as distinct
-- in a unique index, so any number of password-only users can share
-- googleId = NULL.
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;

CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
