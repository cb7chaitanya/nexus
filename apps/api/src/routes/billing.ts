import { withTenantTransaction } from "@raas/db";
import { ApiError, createPortalSessionSchema, parseOrThrow } from "@raas/shared";
import { EventName } from "@paddle/paddle-node-sdk";
import type { FastifyInstance } from "fastify";

import { env } from "../env.js";
import { getPaddleClient } from "../lib/paddle-client.js";
import { requireMembership } from "../lib/membership.js";
import { requireAuth } from "../plugins/auth-guard.js";

const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  EventName.SubscriptionCreated,
  EventName.SubscriptionUpdated,
  EventName.SubscriptionCanceled,
]);

interface SubscriptionEventData {
  id: string;
  status: string;
  customerId: string;
  items: { price: { id: string } | null }[];
  customData: Record<string, unknown> | null;
}

/** Only one paid tier exists today (Pro) — a canceled subscription always
 * reverts to free; an active/trialing/past_due one with a Pro-priced item
 * is "pro"; anything else falls back to "free" rather than guessing. */
function resolvePlan(data: SubscriptionEventData): string {
  if (data.status === "canceled") return "free";
  const hasProPrice = data.items.some((item) => item.price?.id === env.PADDLE_PRO_PRICE_ID);
  return hasProPrice ? "pro" : "free";
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // Billing is entirely optional — see env.ts's comment on PADDLE_API_KEY.
  // Not registering these routes at all when it's unset (rather than
  // registering them and having them fail per-request) means an
  // unconfigured deployment's frontend simply gets a 404, not a confusing
  // runtime error — same reasoning routes/auth.ts already applies to
  // GOOGLE_CLIENT_ID-gated Google OAuth routes.
  if (!env.PADDLE_API_KEY) {
    return;
  }

  // Own encapsulated child scope so the raw-body content-type parser below
  // only applies to this one route — every other route in this app
  // (registered on `app` directly, a sibling scope) keeps Fastify's normal
  // JSON body parsing untouched.
  await app.register(async (webhookScope) => {
    // Paddle's signature is computed over the exact raw bytes — Fastify's
    // default JSON parser discards those in favor of the parsed object, so
    // this route needs its own parser that hands back the untouched buffer
    // instead. See paddle.webhooks.unmarshal below, which needs that exact
    // raw string.
    webhookScope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });

    webhookScope.post("/billing/webhook", async (request, reply) => {
      const signature = request.headers["paddle-signature"];
      if (typeof signature !== "string") {
        return reply.status(400).send();
      }

      const rawBody = (request.body as Buffer).toString("utf-8");

      let event;
      try {
        event = await getPaddleClient().webhooks.unmarshal(rawBody, env.PADDLE_WEBHOOK_SECRET!, signature);
      } catch (err) {
        // Invalid/unverifiable signature — never trusted, regardless of
        // what the payload claims. No requireAuth on this route at all;
        // this check IS the authentication.
        request.log.warn({ err }, "Paddle webhook signature verification failed");
        return reply.status(400).send();
      }

      if (!SUBSCRIPTION_EVENTS.has(event.eventType)) {
        // Acknowledged but irrelevant to plan/subscription state (e.g.
        // customer.updated, transaction.*) — 200 so Paddle doesn't retry
        // an event this handler was never going to act on.
        return reply.status(200).send();
      }

      const data = event.data as unknown as SubscriptionEventData;
      const organizationId = data.customData?.organizationId;
      if (typeof organizationId !== "string") {
        request.log.warn({ eventType: event.eventType }, "Paddle subscription event missing organizationId in customData — ignoring");
        return reply.status(200).send();
      }

      const plan = resolvePlan(data);
      const occurredAt = new Date(event.occurredAt);

      await withTenantTransaction(organizationId, async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: organizationId } });
        if (!org) {
          request.log.warn({ organizationId }, "Paddle webhook referenced an organization that no longer exists — ignoring");
          return;
        }
        // Paddle does not guarantee webhook delivery order — a later-
        // occurring event can arrive before an earlier one. Only apply
        // this event if it's genuinely newer than whatever was last
        // recorded, so a late-arriving stale event can't clobber newer
        // state.
        if (org.subscriptionUpdatedAt && occurredAt <= org.subscriptionUpdatedAt) {
          return;
        }
        await tx.organization.update({
          where: { id: organizationId },
          data: {
            plan,
            paddleCustomerId: data.customerId,
            paddleSubscriptionId: data.id,
            subscriptionStatus: data.status,
            subscriptionUpdatedAt: occurredAt,
          },
        });
      });

      reply.status(200).send();
    });
  });

  app.post("/billing/portal-session", { preHandler: requireAuth }, async (request, reply) => {
    const input = parseOrThrow(createPortalSessionSchema, request.body);
    const userId = request.userId;
    if (!userId) throw ApiError.unauthorized();

    await requireMembership(request, input.organizationId, userId);

    const org = await withTenantTransaction(input.organizationId, (tx) => tx.organization.findUnique({ where: { id: input.organizationId } }));
    if (!org?.paddleCustomerId || !org.paddleSubscriptionId) {
      throw ApiError.conflict("This organization has no active Paddle subscription to manage");
    }

    const session = await getPaddleClient().customerPortalSessions.create(org.paddleCustomerId, [org.paddleSubscriptionId]);
    reply.send({ url: session.urls.general.overview });
  });
}
