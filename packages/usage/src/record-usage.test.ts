/**
 * Real Postgres integration test — RLS scoping on UsageEvent can't be
 * meaningfully verified without a live database. Prerequisites:
 * docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { prisma, withTenantTransaction } from "@raas/db";
import { embeddingTokensTotal, llmTokensTotal } from "@raas/metrics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordUsage } from "./record-usage.js";

describe("recordUsage", () => {
  const suffix = randomUUID().slice(0, 8);
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: { id: string };

  beforeAll(async () => {
    orgA = await prisma.organization.create({ data: { name: `Usage Org A ${suffix}`, slug: `usage-org-a-${suffix}` } });
    orgB = await prisma.organization.create({ data: { name: `Usage Org B ${suffix}`, slug: `usage-org-b-${suffix}` } });
    userA = await prisma.user.create({ data: { email: `usage-user-${suffix}@example.com` } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userA.id } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: orgA.id } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: orgB.id } }).catch(() => undefined);
  });

  it("writes a row visible only within the same organization's tenant context", async () => {
    await recordUsage({
      organizationId: orgA.id,
      userId: userA.id,
      type: "CHAT_REQUEST",
      metadata: { conversationId: randomUUID() },
    });

    const asOrgA = await withTenantTransaction(orgA.id, (tx) => tx.usageEvent.findMany());
    const asOrgB = await withTenantTransaction(orgB.id, (tx) => tx.usageEvent.findMany());

    expect(asOrgA.length).toBeGreaterThan(0);
    expect(asOrgA.every((e) => e.organizationId === orgA.id)).toBe(true);
    expect(asOrgB).toHaveLength(0);
  });

  it("stores metadata as real, queryable JSON", async () => {
    await recordUsage({
      organizationId: orgA.id,
      type: "EMBEDDING_TOKENS",
      metadata: { model: "text-embedding-3-small", documentId: "doc-123", tokenCount: 456 },
    });

    const events = await withTenantTransaction(orgA.id, (tx) => tx.usageEvent.findMany({ where: { type: "EMBEDDING_TOKENS" } }));
    const match = events.find((e) => (e.metadata as Record<string, unknown>).documentId === "doc-123");
    expect(match).toBeDefined();
    expect((match!.metadata as Record<string, unknown>).tokenCount).toBe(456);
  });

  it("allows a null userId (system-attributed usage, e.g. ingestion)", async () => {
    await recordUsage({ organizationId: orgA.id, type: "DOCUMENT_PROCESSED", metadata: { documentId: "doc-456" } });

    const events = await withTenantTransaction(orgA.id, (tx) => tx.usageEvent.findMany({ where: { type: "DOCUMENT_PROCESSED" } }));
    expect(events.some((e) => e.userId === null)).toBe(true);
  });

  it("composes into an existing transaction and rolls back with it", async () => {
    const marker = randomUUID();

    await expect(
      withTenantTransaction(orgA.id, async (tx) => {
        await recordUsage({ organizationId: orgA.id, type: "CHAT_REQUEST", metadata: { marker } }, tx);
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");

    const events = await withTenantTransaction(orgA.id, (tx) => tx.usageEvent.findMany());
    expect(events.some((e) => (e.metadata as Record<string, unknown>).marker === marker)).toBe(false);
  });

  it("commits alongside other writes when passed a shared transaction", async () => {
    const marker = randomUUID();

    await withTenantTransaction(orgA.id, async (tx) => {
      const kb = await tx.knowledgeBase.create({
        data: { organizationId: orgA.id, name: `Usage KB ${marker}`, embeddingProvider: "openai", embeddingModel: "text-embedding-3-small", embeddingDim: 1536 },
      });
      await recordUsage({ organizationId: orgA.id, type: "CHAT_REQUEST", metadata: { marker, knowledgeBaseId: kb.id } }, tx);
    });

    const events = await withTenantTransaction(orgA.id, (tx) => tx.usageEvent.findMany());
    expect(events.some((e) => (e.metadata as Record<string, unknown>).marker === marker)).toBe(true);
  });

  it("increments the embedding-tokens metric with the token count and model from metadata", async () => {
    embeddingTokensTotal.reset();

    await recordUsage({
      organizationId: orgA.id,
      type: "EMBEDDING_TOKENS",
      metadata: { model: "text-embedding-3-small", documentId: "doc-metric", tokenCount: 321 },
    });

    const metric = await embeddingTokensTotal.get();
    expect(metric.values).toEqual([expect.objectContaining({ labels: { model: "text-embedding-3-small" }, value: 321 })]);
  });

  it("increments the LLM-tokens metric separately for prompt and completion kinds", async () => {
    llmTokensTotal.reset();

    await withTenantTransaction(orgA.id, async (tx) => {
      await recordUsage({ organizationId: orgA.id, type: "CHAT_PROMPT_TOKENS", metadata: { model: "gpt-4o-mini", tokenCount: 100 } }, tx);
      await recordUsage({ organizationId: orgA.id, type: "CHAT_COMPLETION_TOKENS", metadata: { model: "gpt-4o-mini", tokenCount: 40 } }, tx);
    });

    const metric = await llmTokensTotal.get();
    expect(metric.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labels: { model: "gpt-4o-mini", kind: "prompt" }, value: 100 }),
        expect.objectContaining({ labels: { model: "gpt-4o-mini", kind: "completion" }, value: 40 }),
      ]),
    );
  });

  it("does not touch either token metric for a CHAT_REQUEST or DOCUMENT_PROCESSED event (no token dimension)", async () => {
    embeddingTokensTotal.reset();
    llmTokensTotal.reset();

    await recordUsage({ organizationId: orgA.id, type: "CHAT_REQUEST", metadata: { conversationId: randomUUID() } });
    await recordUsage({ organizationId: orgA.id, type: "DOCUMENT_PROCESSED", metadata: { documentId: "doc-x" } });

    expect((await embeddingTokensTotal.get()).values).toHaveLength(0);
    expect((await llmTokensTotal.get()).values).toHaveLength(0);
  });
});
