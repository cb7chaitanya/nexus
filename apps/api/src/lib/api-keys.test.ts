/**
 * Real Postgres integration test for recordApiKeyUsage — the generate/hash
 * functions are pure and tested without any infra dependency.
 * Prerequisites: docker compose up -d.
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateApiKey, hashApiKey, recordApiKeyUsage } from "./api-keys.js";

describe("generateApiKey", () => {
  it("produces a raw key with the rk_live_ prefix and a shorter, matching display prefix", () => {
    const { raw, prefix } = generateApiKey();
    expect(raw.startsWith("rk_live_")).toBe(true);
    expect(prefix.length).toBeLessThan(raw.length);
    expect(raw.startsWith(prefix)).toBe(true);
  });

  it("never generates the same raw key twice", () => {
    const first = generateApiKey();
    const second = generateApiKey();
    expect(first.raw).not.toBe(second.raw);
  });
});

describe("hashApiKey", () => {
  it("is deterministic — the same raw key always hashes the same way", () => {
    const { raw } = generateApiKey();
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
  });

  it("never equals the raw input", () => {
    const { raw } = generateApiKey();
    expect(hashApiKey(raw)).not.toBe(raw);
  });

  it("produces different hashes for different keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(hashApiKey(a.raw)).not.toBe(hashApiKey(b.raw));
  });
});

describe("recordApiKeyUsage", () => {
  const suffix = randomUUID().slice(0, 8);
  let orgA: { id: string };
  let orgB: { id: string };
  let keyId: string;

  beforeAll(async () => {
    orgA = await prisma.organization.create({ data: { name: `ApiKey Usage Org A ${suffix}`, slug: `apikey-usage-a-${suffix}` } });
    orgB = await prisma.organization.create({ data: { name: `ApiKey Usage Org B ${suffix}`, slug: `apikey-usage-b-${suffix}` } });

    const { raw } = generateApiKey();
    const key = await withTenantTransaction(orgA.id, (tx) =>
      tx.apiKey.create({
        data: { organizationId: orgA.id, name: "Usage Test Key", hashedKey: hashApiKey(raw), prefix: raw.slice(0, 12) },
      }),
    );
    keyId = key.id;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgA.id } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: orgB.id } }).catch(() => undefined);
  });

  it("sets lastUsedAt on the correct key", async () => {
    expect((await withTenantTransaction(orgA.id, (tx) => tx.apiKey.findUnique({ where: { id: keyId } })))!.lastUsedAt).toBeNull();

    await recordApiKeyUsage(orgA.id, keyId);

    expect((await withTenantTransaction(orgA.id, (tx) => tx.apiKey.findUnique({ where: { id: keyId } })))!.lastUsedAt).not.toBeNull();
  });

  it("does nothing when the organizationId doesn't match the key's actual org", async () => {
    const before = (await withTenantTransaction(orgA.id, (tx) => tx.apiKey.findUnique({ where: { id: keyId } })))!.lastUsedAt;

    // Wrong org for this key — RLS scopes every row in this transaction to
    // orgB, so the key (which belongs to orgA) isn't visible to update at
    // all; updateMany matches zero rows for the same reason an app-level
    // organizationId filter used to.
    await recordApiKeyUsage(orgB.id, keyId);

    const after = (await withTenantTransaction(orgA.id, (tx) => tx.apiKey.findUnique({ where: { id: keyId } })))!.lastUsedAt;
    expect(after?.getTime()).toBe(before?.getTime());
  });
});
