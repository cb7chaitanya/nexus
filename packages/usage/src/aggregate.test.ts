/**
 * Real Postgres integration test — the aggregation query's GROUP BY /
 * JSON-extraction correctness can't be meaningfully verified without a
 * live database. Prerequisites: docker compose up -d, migrations applied.
 */
import { randomUUID } from "node:crypto";

import { prisma } from "@raas/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { aggregateUsage, computeUsageTotals } from "./aggregate.js";
import { recordUsage } from "./record-usage.js";

describe("aggregateUsage / computeUsageTotals", () => {
  const suffix = randomUUID().slice(0, 8);
  let org: { id: string };
  let emptyOrg: { id: string };
  const from = new Date(Date.now() - 60_000);
  let to: Date;

  beforeAll(async () => {
    org = await prisma.organization.create({ data: { name: `Aggregate Org ${suffix}`, slug: `aggregate-org-${suffix}` } });
    emptyOrg = await prisma.organization.create({ data: { name: `Aggregate Empty Org ${suffix}`, slug: `aggregate-empty-org-${suffix}` } });

    await recordUsage({ organizationId: org.id, type: "CHAT_REQUEST", metadata: { conversationId: randomUUID() } });
    await recordUsage({ organizationId: org.id, type: "CHAT_REQUEST", metadata: { conversationId: randomUUID() } });
    await recordUsage({ organizationId: org.id, type: "CHAT_PROMPT_TOKENS", metadata: { tokenCount: 100 } });
    await recordUsage({ organizationId: org.id, type: "CHAT_COMPLETION_TOKENS", metadata: { tokenCount: 250 } });
    await recordUsage({ organizationId: org.id, type: "EMBEDDING_TOKENS", metadata: { tokenCount: 5000 } });
    await recordUsage({ organizationId: org.id, type: "DOCUMENT_PROCESSED", metadata: { documentId: randomUUID() } });

    to = new Date(Date.now() + 60_000);
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: emptyOrg.id } }).catch(() => undefined);
  });

  it("returns a valid, empty breakdown and zeroed totals for an org with no usage events", async () => {
    const breakdown = await aggregateUsage({ organizationId: emptyOrg.id, from, to });
    expect(breakdown).toEqual([]);

    const totals = computeUsageTotals(breakdown);
    expect(totals).toEqual({ embeddingTokens: 0, completionTokens: 0, requestCount: 0, estimatedCost: 0 });
  });

  it("groups events by day and type, with correct per-row token sums", async () => {
    const breakdown = await aggregateUsage({ organizationId: org.id, from, to });

    const chatRequestRow = breakdown.find((r) => r.eventType === "CHAT_REQUEST");
    const embeddingRow = breakdown.find((r) => r.eventType === "EMBEDDING_TOKENS");
    const completionRow = breakdown.find((r) => r.eventType === "CHAT_COMPLETION_TOKENS");

    expect(chatRequestRow?.requestCount).toBe(2);
    expect(chatRequestRow?.tokens).toBe(0); // CHAT_REQUEST metadata carries no tokenCount
    expect(embeddingRow?.tokens).toBe(5000);
    expect(completionRow?.tokens).toBe(250);
  });

  it("computes totals matching the recorded events, counting only CHAT_REQUEST toward requestCount", async () => {
    const breakdown = await aggregateUsage({ organizationId: org.id, from, to });
    const totals = computeUsageTotals(breakdown);

    expect(totals.embeddingTokens).toBe(5000);
    expect(totals.completionTokens).toBe(250);
    expect(totals.requestCount).toBe(2);
    expect(totals.estimatedCost).toBeGreaterThan(0);
  });

  it("excludes events outside the requested time range", async () => {
    const farFuture = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const breakdown = await aggregateUsage({ organizationId: org.id, from: farFuture, to: new Date(farFuture.getTime() + 60_000) });
    expect(breakdown).toEqual([]);
  });
});
