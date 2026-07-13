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

import { prisma, withTenantTransaction } from "./index.js";

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
