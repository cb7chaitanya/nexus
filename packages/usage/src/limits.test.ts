/**
 * Real Postgres integration test — RLS scoping on OrganizationUsageLimit
 * can't be meaningfully verified without a live database. Prerequisites:
 * docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getOrganizationDailyLimit } from "./limits.js";

describe("getOrganizationDailyLimit", () => {
  const suffix = randomUUID().slice(0, 8);
  let orgWithRow: { id: string };
  let orgWithoutRow: { id: string };

  beforeAll(async () => {
    orgWithRow = await prisma.organization.create({ data: { name: `Limits Org A ${suffix}`, slug: `limits-org-a-${suffix}` } });
    orgWithoutRow = await prisma.organization.create({ data: { name: `Limits Org B ${suffix}`, slug: `limits-org-b-${suffix}` } });

    await withTenantTransaction(orgWithRow.id, (tx) =>
      tx.organizationUsageLimit.create({
        data: { organizationId: orgWithRow.id, maxDocumentsPerDay: 5, maxEmbeddingTokensPerDay: 1000, maxChatTokensPerDay: 2000 },
      }),
    );
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgWithRow.id } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: orgWithoutRow.id } }).catch(() => undefined);
  });

  it("returns the org's own configured ceiling when a row exists", async () => {
    const limit = await getOrganizationDailyLimit(orgWithRow.id, "maxDocumentsPerDay", 999);
    expect(limit).toBe(5);
  });

  it("falls back to the provided default when no row exists for the org", async () => {
    const limit = await getOrganizationDailyLimit(orgWithoutRow.id, "maxDocumentsPerDay", 999);
    expect(limit).toBe(999);
  });

  it("resolves each dimension independently from the same row", async () => {
    const embeddingLimit = await getOrganizationDailyLimit(orgWithRow.id, "maxEmbeddingTokensPerDay", 0);
    const chatLimit = await getOrganizationDailyLimit(orgWithRow.id, "maxChatTokensPerDay", 0);
    expect(embeddingLimit).toBe(1000);
    expect(chatLimit).toBe(2000);
  });
});
