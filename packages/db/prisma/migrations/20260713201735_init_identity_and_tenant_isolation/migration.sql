-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_organizationId_slug_key" ON "Workspace"("organizationId", "slug");

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────────────────── Row-Level Security ─────────────────────────
-- Enabled in this same migration, not a follow-up one, per
-- docs/roadmap.md: "Postgres RLS enabled on tenant tables from the very
-- first migration that introduces a tenant-scoped table."
--
-- FORCE (not just ENABLE) is required: Postgres exempts the table owner
-- from RLS by default, and in this stack the same role runs migrations
-- and serves app queries. Without FORCE, these policies would be enabled
-- but silently do nothing for the app's own connection.
--
-- Policies deliberately omit the missing_ok flag on current_setting(), so
-- a query that reaches these tables without going through
-- withTenantTransaction (src/tenant.ts) raises a Postgres error rather
-- than silently returning zero rows — a missing tenant context should be
-- loud, not indistinguishable from "no data yet".
--
-- Organization and User are intentionally NOT RLS-scoped here — see
-- docs/decisions.md for why.
--
-- organizationId is compared as text, not cast to ::uuid: Prisma's default
-- `String @id @default(uuid())` maps to Postgres TEXT, not the native uuid
-- type, so a ::uuid cast on one side of the comparison with a TEXT column
-- on the other raises "operator does not exist: text = uuid" — caught by
-- actually running this migration, not assumed.

-- CreateRowLevelSecurity
ALTER TABLE "OrganizationMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationMember" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "OrganizationMember"
  USING ("organizationId" = current_setting('app.current_org_id'))
  WITH CHECK ("organizationId" = current_setting('app.current_org_id'));

-- CreateRowLevelSecurity
ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Workspace" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "Workspace"
  USING ("organizationId" = current_setting('app.current_org_id'))
  WITH CHECK ("organizationId" = current_setting('app.current_org_id'));

