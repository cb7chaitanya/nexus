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
 * this function": for Workspace, empirically, a Postgres connection that
 * has NEVER once referenced app.current_org_id raises a hard error (fail
 * loud). But once a pooled connection has been used by ANY
 * withTenantTransaction call (for any org), Postgres retains a
 * session-local placeholder for that GUC name for the rest of that
 * connection's lifetime — later unscoped queries on that SAME connection
 * get back an empty string instead of an error, which still matches no
 * real organizationId and so still returns zero rows. In a long-running
 * pooled server this second case is the common one, not the first. The
 * security property that actually holds unconditionally, verified both
 * ways: a missing tenant context NEVER returns another tenant's rows — it
 * returns either an error or nothing, never data. See docs/decisions.md
 * for the full investigation.
 *
 * OrganizationMember's policy was changed (see migration
 * 20260715081815_add_self_membership_lookup) to always use missing_ok on
 * current_setting() — needed so the sibling self-lookup policy used by
 * withUserContext below can actually work. It now always fails closed via
 * an empty result rather than sometimes erroring; still zero data leakage,
 * just uniform instead of connection-history-dependent.
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

/**
 * Runs `callback` inside a single Postgres transaction with
 * `app.current_user_id` set for the duration of that transaction.
 *
 * This is NOT a general tenant-context mechanism and must not be treated
 * as an alternative to withTenantTransaction. It exists for exactly one
 * purpose: answering "which orgs does this user belong to" — needed by
 * login and GET /auth/me, where no org has been selected yet, so
 * withTenantTransaction has no orgId to take. Only OrganizationMember has
 * a policy that references app.current_user_id (self_membership_lookup,
 * SELECT-only — see migration 20260715081815_add_self_membership_lookup),
 * and it only ever grants visibility into the CALLING user's own
 * membership rows, nothing about other users or other tenants' data. No
 * other table's RLS policy references this session variable; using this
 * function to query anything other than "my own memberships" relies on
 * undefined behavior.
 *
 * Once an org has been selected (from the result of this call, or from a
 * client-supplied org id validated against that result), every subsequent
 * query goes back through withTenantTransaction like normal.
 */
export async function withUserContext<T>(
  userId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(userId)) {
    throw new Error(`withUserContext: userId must be a UUID, got: ${JSON.stringify(userId)}`);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
    return callback(tx);
  });
}
