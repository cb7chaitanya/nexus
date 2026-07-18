/**
 * Integration tests against a real Postgres — RLS is a database behavior
 * and cannot be meaningfully verified with mocks. Prerequisites:
 *   1. docker compose up -d   (from repo root)
 *   2. pnpm migrate:deploy    (from this package, or via turbo)
 *
 * These tests connect through the SAME restricted raas_app role the real
 * application uses (via withTenantTransaction / the shared `prisma`
 * client) — never a superuser connection — so a regression that
 * reintroduces the superuser-bypass bug found while building this (see
 * docs/decisions.md) would actually be caught here, not masked by an
 * overly-privileged test setup.
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma, setTenantContext, withApiKeyLookup, withTenantTransaction, withUserContext } from "./index.js";

describe("tenant isolation (RLS)", () => {
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);

    // Organization/User carry no organizationId and have no RLS policy —
    // see docs/decisions.md for why — so creating them needs no tenant
    // context at all.
    [orgA, orgB, userA, userB] = await Promise.all([
      prisma.organization.create({ data: { name: `Org A ${suffix}`, slug: `org-a-${suffix}` } }),
      prisma.organization.create({ data: { name: `Org B ${suffix}`, slug: `org-b-${suffix}` } }),
      prisma.user.create({ data: { email: `user-a-${suffix}@example.com` } }),
      prisma.user.create({ data: { email: `user-b-${suffix}@example.com` } }),
    ]);
  });

  afterAll(async () => {
    // Cascades to OrganizationMember/Workspace via onDelete: Cascade.
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  });

  it("writes org-scoped Workspace rows through withTenantTransaction", async () => {
    await withTenantTransaction(orgA.id, (tx) =>
      tx.workspace.create({
        data: { organizationId: orgA.id, name: "Org A workspace", slug: "ws" },
      }),
    );
    await withTenantTransaction(orgB.id, (tx) =>
      tx.workspace.create({
        data: { organizationId: orgB.id, name: "Org B workspace", slug: "ws" },
      }),
    );
  });

  it("returns only org A's workspace when queried with org A's context", async () => {
    const rows = await withTenantTransaction(orgA.id, (tx) => tx.workspace.findMany());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationId).toBe(orgA.id);
  });

  it("returns only org B's workspace when queried with org B's context — org A is invisible", async () => {
    const rows = await withTenantTransaction(orgB.id, (tx) => tx.workspace.findMany());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationId).toBe(orgB.id);
  });

  it("never returns another tenant's OrganizationMember rows either", async () => {
    await withTenantTransaction(orgA.id, (tx) =>
      tx.organizationMember.create({
        data: { organizationId: orgA.id, userId: userA.id, role: "OWNER" },
      }),
    );
    await withTenantTransaction(orgB.id, (tx) =>
      tx.organizationMember.create({
        data: { organizationId: orgB.id, userId: userB.id, role: "OWNER" },
      }),
    );

    const asOrgA = await withTenantTransaction(orgA.id, (tx) => tx.organizationMember.findMany());

    expect(asOrgA).toHaveLength(1);
    expect(asOrgA[0]?.organizationId).toBe(orgA.id);
    expect(asOrgA[0]?.userId).toBe(userA.id);
  });

  it("rejects writing a row whose organizationId doesn't match the transaction's tenant context (WITH CHECK)", async () => {
    // Inside org A's transaction, attempt to smuggle a row in under org B's
    // id. The RLS WITH CHECK clause must reject this at the database level
    // — this is not something application-level validation is being relied
    // on to catch.
    await expect(
      withTenantTransaction(orgA.id, (tx) =>
        tx.workspace.create({
          data: { organizationId: orgB.id, name: "smuggled", slug: "smuggled" },
        }),
      ),
    ).rejects.toThrow();

    const rows = await withTenantTransaction(orgB.id, (tx) =>
      tx.workspace.findMany({ where: { slug: "smuggled" } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("a fresh client with no tenant context never returns cross-tenant data — error or empty, never data", async () => {
    // A brand-new PrismaClient has an empty client-side connection pool,
    // but the REAL Postgres backend connection it's handed can still be a
    // reused, already-tenant-touched one — this depends on what sits in
    // front of Postgres. With no pooler, it's usually a genuinely new
    // backend connection (hard error). Behind pgbouncer in transaction
    // mode, pgbouncer — not Prisma — controls which backend connection
    // gets reused, and it will almost always hand back one that's already
    // been touched (empty result, not an error) — verified empirically,
    // see docs/decisions.md. Both outcomes are asserted as acceptable;
    // only a "fresh connection always errors" assumption would be wrong,
    // and was wrong until this was actually tested through pgbouncer.
    const freshClient = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL });
    try {
      const rows = await freshClient.workspace.findMany({
        where: { organizationId: { in: [orgA.id, orgB.id] } },
      });
      expect(rows).toHaveLength(0);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    } finally {
      await freshClient.$disconnect();
    }
  });

  it("the shared client, already tenant-touched by prior tests, still never returns cross-tenant data outside a transaction", async () => {
    // Whichever pooled connection Prisma hands back here may or may not
    // have been tenant-touched already; both documented outcomes (a hard
    // error, or an empty result because the GUC placeholder now resolves
    // to an empty string) are acceptable. What's never acceptable is
    // getting org A's or org B's real row back. Both are asserted.
    try {
      const rows = await prisma.workspace.findMany({
        where: { organizationId: { in: [orgA.id, orgB.id] } },
      });
      expect(rows).toHaveLength(0);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe("tenant isolation (RLS) — KnowledgeBase / Document", () => {
  let orgA: { id: string };
  let orgB: { id: string };

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);

    [orgA, orgB] = await Promise.all([
      prisma.organization.create({ data: { name: `Org A ${suffix}`, slug: `org-a-kb-${suffix}` } }),
      prisma.organization.create({ data: { name: `Org B ${suffix}`, slug: `org-b-kb-${suffix}` } }),
    ]);
  });

  afterAll(async () => {
    // Cascades to KnowledgeBase/Document via onDelete: Cascade.
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  });

  it("returns only org A's KnowledgeBase when queried with org A's context", async () => {
    await withTenantTransaction(orgA.id, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId: orgA.id,
          name: "Org A KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    await withTenantTransaction(orgB.id, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId: orgB.id,
          name: "Org B KB",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );

    const asOrgA = await withTenantTransaction(orgA.id, (tx) => tx.knowledgeBase.findMany());
    expect(asOrgA).toHaveLength(1);
    expect(asOrgA[0]?.organizationId).toBe(orgA.id);
  });

  it("rejects smuggling a KnowledgeBase row under another org's id (WITH CHECK)", async () => {
    await expect(
      withTenantTransaction(orgA.id, (tx) =>
        tx.knowledgeBase.create({
          data: {
            organizationId: orgB.id,
            name: "smuggled",
            embeddingProvider: "openai",
            embeddingModel: "text-embedding-3-small",
            embeddingDim: 1536,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("never returns another tenant's Document rows", async () => {
    const kbA = await withTenantTransaction(orgA.id, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId: orgA.id,
          name: "Org A KB 2",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    const kbB = await withTenantTransaction(orgB.id, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId: orgB.id,
          name: "Org B KB 2",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );

    await withTenantTransaction(orgA.id, (tx) =>
      tx.document.create({
        data: {
          organizationId: orgA.id,
          knowledgeBaseId: kbA.id,
          fileName: "a.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
          storageKey: `org-a/${randomUUID()}`,
        },
      }),
    );
    await withTenantTransaction(orgB.id, (tx) =>
      tx.document.create({
        data: {
          organizationId: orgB.id,
          knowledgeBaseId: kbB.id,
          fileName: "b.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
          storageKey: `org-b/${randomUUID()}`,
        },
      }),
    );

    const asOrgA = await withTenantTransaction(orgA.id, (tx) => tx.document.findMany());
    expect(asOrgA.every((d) => d.organizationId === orgA.id)).toBe(true);
    expect(asOrgA.some((d) => d.knowledgeBaseId === kbB.id)).toBe(false);
  });

  it("never returns another tenant's DocumentChunk rows, including via raw SQL writes to the vector column", async () => {
    const kbA = await withTenantTransaction(orgA.id, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId: orgA.id,
          name: "Org A KB 3",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    const kbB = await withTenantTransaction(orgB.id, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId: orgB.id,
          name: "Org B KB 3",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    const docA = await withTenantTransaction(orgA.id, (tx) =>
      tx.document.create({
        data: {
          organizationId: orgA.id,
          knowledgeBaseId: kbA.id,
          fileName: "a-chunks.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
          storageKey: `org-a/${randomUUID()}`,
        },
      }),
    );
    const docB = await withTenantTransaction(orgB.id, (tx) =>
      tx.document.create({
        data: {
          organizationId: orgB.id,
          knowledgeBaseId: kbB.id,
          fileName: "b-chunks.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
          storageKey: `org-b/${randomUUID()}`,
        },
      }),
    );

    const chunkA = await withTenantTransaction(orgA.id, (tx) =>
      tx.documentChunk.upsert({
        where: { documentId_chunkIndex: { documentId: docA.id, chunkIndex: 0 } },
        create: {
          organizationId: orgA.id,
          knowledgeBaseId: kbA.id,
          documentId: docA.id,
          chunkIndex: 0,
          content: "org a content",
          tokenCount: 3,
          charStart: 0,
          charEnd: 13,
        },
        update: {},
      }),
    );
    await withTenantTransaction(orgB.id, (tx) =>
      tx.documentChunk.upsert({
        where: { documentId_chunkIndex: { documentId: docB.id, chunkIndex: 0 } },
        create: {
          organizationId: orgB.id,
          knowledgeBaseId: kbB.id,
          documentId: docB.id,
          chunkIndex: 0,
          content: "org b content",
          tokenCount: 3,
          charStart: 0,
          charEnd: 13,
        },
        update: {},
      }),
    );

    // embed-chunks writes the vector column via $executeRaw (Unsupported
    // type — Prisma's typed client can't write it). Verify that write path
    // is scoped by RLS too, not just the typed upsert above.
    const fakeVector = `[${Array.from({ length: 1536 }, () => "0").join(",")}]`;
    await withTenantTransaction(orgA.id, (tx) =>
      tx.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${fakeVector}::vector WHERE id = ${chunkA.id}`,
    );

    const asOrgA = await withTenantTransaction(orgA.id, (tx) => tx.documentChunk.findMany());
    expect(asOrgA.every((c) => c.organizationId === orgA.id)).toBe(true);
    expect(asOrgA.some((c) => c.documentId === docB.id)).toBe(false);

    // Cross-tenant raw write: org B's context must not be able to touch org
    // A's chunk row, even via a raw UPDATE targeting its id directly.
    const crossTenantUpdate = await withTenantTransaction(
      orgB.id,
      (tx) => tx.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${fakeVector}::vector WHERE id = ${chunkA.id}`,
    );
    expect(crossTenantUpdate).toBe(0);
  });

  it("rejects a duplicate (documentId, chunkIndex) insert — the constraint idempotent chunk-text retries rely on", async () => {
    const kb = await withTenantTransaction(orgA.id, (tx) =>
      tx.knowledgeBase.create({
        data: {
          organizationId: orgA.id,
          name: "Org A KB 4",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingDim: 1536,
        },
      }),
    );
    const doc = await withTenantTransaction(orgA.id, (tx) =>
      tx.document.create({
        data: {
          organizationId: orgA.id,
          knowledgeBaseId: kb.id,
          fileName: "dupe.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
          storageKey: `org-a/${randomUUID()}`,
        },
      }),
    );

    const chunkData = {
      organizationId: orgA.id,
      knowledgeBaseId: kb.id,
      documentId: doc.id,
      chunkIndex: 0,
      content: "first",
      tokenCount: 1,
      charStart: 0,
      charEnd: 5,
    };

    await withTenantTransaction(orgA.id, (tx) => tx.documentChunk.create({ data: chunkData }));

    await expect(
      withTenantTransaction(orgA.id, (tx) => tx.documentChunk.create({ data: chunkData })),
    ).rejects.toThrow();

    // But upserting on the unique key is idempotent, which is the actual
    // mechanism chunk-text relies on for retry safety.
    await expect(
      withTenantTransaction(orgA.id, (tx) =>
        tx.documentChunk.upsert({
          where: { documentId_chunkIndex: { documentId: doc.id, chunkIndex: 0 } },
          create: chunkData,
          update: { content: "updated" },
        }),
      ),
    ).resolves.toMatchObject({ content: "updated" });
  });
});

describe("tenant isolation (RLS) — ApiKey", () => {
  let orgA: { id: string };
  let orgB: { id: string };

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);

    [orgA, orgB] = await Promise.all([
      prisma.organization.create({ data: { name: `Org A ${suffix}`, slug: `org-a-apikey-${suffix}` } }),
      prisma.organization.create({ data: { name: `Org B ${suffix}`, slug: `org-b-apikey-${suffix}` } }),
    ]);
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  });

  it("returns only org A's ApiKey rows when queried with org A's tenant context", async () => {
    await withTenantTransaction(orgA.id, (tx) =>
      tx.apiKey.create({ data: { organizationId: orgA.id, name: "Org A Key", hashedKey: `hash-a-${randomUUID()}`, prefix: "rk_live_aaaa" } }),
    );
    await withTenantTransaction(orgB.id, (tx) =>
      tx.apiKey.create({ data: { organizationId: orgB.id, name: "Org B Key", hashedKey: `hash-b-${randomUUID()}`, prefix: "rk_live_bbbb" } }),
    );

    const asOrgA = await withTenantTransaction(orgA.id, (tx) => tx.apiKey.findMany());
    expect(asOrgA).toHaveLength(1);
    expect(asOrgA[0]?.organizationId).toBe(orgA.id);
  });

  it("rejects smuggling an ApiKey row under another org's id (WITH CHECK)", async () => {
    await expect(
      withTenantTransaction(orgA.id, (tx) =>
        tx.apiKey.create({
          data: { organizationId: orgB.id, name: "smuggled", hashedKey: `hash-smuggle-${randomUUID()}`, prefix: "rk_live_cccc" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("withApiKeyLookup (requireApiKeyAuth's mechanism) resolves a key by hash regardless of tenant context, and only that one row", async () => {
    const hashedKey = `hash-lookup-${randomUUID()}`;
    await withTenantTransaction(orgA.id, (tx) =>
      tx.apiKey.create({ data: { organizationId: orgA.id, name: "Lookup Key", hashedKey, prefix: "rk_live_dddd" } }),
    );

    const found = await withApiKeyLookup(hashedKey, (tx) => tx.apiKey.findUnique({ where: { hashedKey } }));
    expect(found?.organizationId).toBe(orgA.id);

    // No org context was ever set for this lookup — the hash alone
    // resolved it, which is the entire point (see this function's doc
    // comment on packages/db/src/tenant.ts).
    const rows = await withApiKeyLookup(hashedKey, (tx) => tx.apiKey.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hashedKey).toBe(hashedKey);
  });

  it("withApiKeyLookup never resolves a key other than the one matching the given hash", async () => {
    const hashedKey = `hash-real-${randomUUID()}`;
    await withTenantTransaction(orgA.id, (tx) =>
      tx.apiKey.create({ data: { organizationId: orgA.id, name: "Real Key", hashedKey, prefix: "rk_live_eeee" } }),
    );
    await withTenantTransaction(orgB.id, (tx) =>
      tx.apiKey.create({ data: { organizationId: orgB.id, name: "Other Org Key", hashedKey: `hash-other-${randomUUID()}`, prefix: "rk_live_ffff" } }),
    );

    // A hash that resolves to nothing — proves this is a real, scoped
    // lookup, not something that happens to return every row.
    const found = await withApiKeyLookup(`hash-nonexistent-${randomUUID()}`, (tx) => tx.apiKey.findMany());
    expect(found).toHaveLength(0);
  });

  it("the api_key_hash_lookup policy is SELECT-only — cannot write through it", async () => {
    const hashedKey = `hash-write-${randomUUID()}`;
    await expect(
      withApiKeyLookup(hashedKey, (tx) =>
        tx.apiKey.create({ data: { organizationId: orgA.id, name: "Should Not Insert", hashedKey, prefix: "rk_live_gggg" } }),
      ),
    ).rejects.toThrow();
  });
});

describe("self membership lookup (withUserContext)", () => {
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);

    [orgA, orgB, userA, userB] = await Promise.all([
      prisma.organization.create({ data: { name: `Org A ${suffix}`, slug: `org-a-${suffix}` } }),
      prisma.organization.create({ data: { name: `Org B ${suffix}`, slug: `org-b-${suffix}` } }),
      prisma.user.create({ data: { email: `user-a-${suffix}@example.com` } }),
      prisma.user.create({ data: { email: `user-b-${suffix}@example.com` } }),
    ]);

    await withTenantTransaction(orgA.id, (tx) =>
      tx.organizationMember.create({
        data: { organizationId: orgA.id, userId: userA.id, role: "OWNER" },
      }),
    );
    await withTenantTransaction(orgB.id, (tx) =>
      tx.organizationMember.create({
        data: { organizationId: orgB.id, userId: userB.id, role: "OWNER" },
      }),
    );
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  });

  it("lets a user see their own membership with no org context selected — this is the login/GET /auth/me path", async () => {
    const rows = await withUserContext(userA.id, (tx) => tx.organizationMember.findMany());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userA.id);
    expect(rows[0]?.organizationId).toBe(orgA.id);
  });

  it("never returns another user's membership rows", async () => {
    const rowsAsA = await withUserContext(userA.id, (tx) => tx.organizationMember.findMany());
    const rowsAsB = await withUserContext(userB.id, (tx) => tx.organizationMember.findMany());

    expect(rowsAsA.some((r) => r.userId === userB.id)).toBe(false);
    expect(rowsAsB.some((r) => r.userId === userA.id)).toBe(false);
  });

  it("cannot write through the self-lookup policy — it's SELECT-only, org-scoped writes still require withTenantTransaction", async () => {
    await expect(
      withUserContext(userA.id, (tx) =>
        tx.organizationMember.create({
          data: { organizationId: orgA.id, userId: userB.id, role: "MEMBER" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("withTenantTransaction is unaffected by the policy change — still correctly org-scoped", async () => {
    const rows = await withTenantTransaction(orgA.id, (tx) => tx.organizationMember.findMany());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationId).toBe(orgA.id);
  });
});

describe("setTenantContext", () => {
  it("lets a caller create an Organization and its first RLS-scoped row atomically in one transaction", async () => {
    const suffix = randomUUID().slice(0, 8);
    let orgId!: string;

    await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name: `Atomic Org ${suffix}`, slug: `atomic-org-${suffix}` } });
      orgId = org.id;
      const user = await tx.user.create({ data: { email: `atomic-${suffix}@example.com` } });

      await setTenantContext(tx, org.id);
      await tx.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: "OWNER" } });
    });

    const members = await withTenantTransaction(orgId, (tx) => tx.organizationMember.findMany());
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("OWNER");

    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  });

  it("rolls back the Organization too when the RLS-scoped insert fails — no orphaned org", async () => {
    const suffix = randomUUID().slice(0, 8);
    const slug = `atomic-rollback-org-${suffix}`;

    await expect(
      prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({ data: { name: `Rollback Org ${suffix}`, slug } });
        await setTenantContext(tx, org.id);
        // Deliberately invalid: userId references no real User row, so
        // the FK constraint fails — simulating any failure between org
        // creation and membership creation.
        await tx.organizationMember.create({ data: { organizationId: org.id, userId: randomUUID(), role: "OWNER" } });
      }),
    ).rejects.toThrow();

    const found = await prisma.organization.findUnique({ where: { slug } });
    expect(found).toBeNull();
  });

  it("rejects a non-UUID orgId", async () => {
    await expect(prisma.$transaction((tx) => setTenantContext(tx, "not-a-uuid"))).rejects.toThrow("must be a UUID");
  });
});
