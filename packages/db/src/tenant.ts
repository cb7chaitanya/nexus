import type { Prisma } from "@prisma/client";

import { prisma } from "./client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `callback` inside a single Postgres transaction with
 * `app.current_org_id` set for the duration of that transaction, which is
 * the session variable every tenant-scoped RLS policy in this schema
 * checks (see the RLS block in
 * prisma/migrations/20260713201735_init_identity_and_tenant_isolation).
 *
 * This is the ONLY sanctioned way to query OrganizationMember/Workspace
 * (and every future RLS-protected table). `callback` receives the
 * transaction's own client (`tx`), not the top-level `prisma` client —
 * that's load-bearing, not stylistic: queries issued on any other client
 * would run on a different pooled connection that never had
 * app.current_org_id set, and RLS would then deny everything on that
 * table rather than scope it correctly.
 *
 * Implementation note: the literal SQL `SET LOCAL app.current_org_id = $1`
 * is not valid as a parameterized/prepared statement — Postgres's `SET`
 * family are utility statements handled outside the normal bind-parameter
 * path and do not accept `$1`-style placeholders (verified against a live
 * connection, not assumed). The parameterized equivalent Postgres actually
 * supports is the `set_config(name, value, is_local)` function — a normal
 * function call, so Prisma's tagged-template `$executeRaw` binds `orgId`
 * as a real parameter through it. `is_local = true` gives the same
 * transaction-scoped reset behavior as SET LOCAL: the setting
 * automatically reverts at COMMIT/ROLLBACK, so a connection handed back to
 * the pool never carries a stale org context into someone else's query.
 *
 * On "what happens if a query reaches an RLS table without going through
 * this function": empirically, a Postgres connection that has NEVER once
 * referenced app.current_org_id raises a hard error (fail loud). But once
 * a pooled connection has been used by ANY withTenantTransaction call
 * (for any org), Postgres retains a session-local placeholder for that
 * GUC name for the rest of that connection's lifetime — later unscoped
 * queries on that SAME connection get back an empty string instead of an
 * error, which still matches no real organizationId and so still returns
 * zero rows. In a long-running pooled server this second case is the
 * common one, not the first. The security property that actually holds
 * unconditionally, verified both ways: a missing tenant context NEVER
 * returns another tenant's rows — it returns either an error or nothing,
 * never data. See docs/decisions.md for the full investigation.
 */
export async function withTenantTransaction<T>(
  orgId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(orgId)) {
    throw new Error(`withTenantTransaction: orgId must be a UUID, got: ${JSON.stringify(orgId)}`);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    return callback(tx);
  });
}
