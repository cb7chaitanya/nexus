import { Gauge } from "prom-client";

import { registry } from "./registry.js";

/**
 * The minimal shape these gauges need from a BullMQ Queue — structurally
 * typed (same "don't force a dependency on the real SDK" approach
 * @raas/observability's SentryLikeClient uses) rather than importing
 * `bullmq`'s own `Queue` type, so this package keeps its zero-runtime-
 * dependency footprint (see package.json) even though every real caller
 * (apps/worker) happens to pass a real `Queue` instance, which already
 * satisfies this shape as-is.
 */
export interface QueueCountsSource {
  /** The BullMQ queue name — becomes this gauge's `queue` label value. */
  name: string;
  getJobCounts(): Promise<Record<string, number>>;
}

/**
 * Queues currently reporting into queueDepth/queueActiveJobs below —
 * populated by registerQueueForMetrics (apps/worker/src/index.ts, once
 * per queue at startup), read by both gauges' own collect() callbacks.
 * Module-level, not passed as a constructor option: prom-client owns
 * *when* collect() runs (on every /metrics scrape — see registry.ts and
 * health-server.ts's handleMetricsRequest), so the set of queues a scrape
 * should report on has to be readable from inside that callback, not
 * threaded through prom-client's own API.
 */
let sources: QueueCountsSource[] = [];

/**
 * Registers `queue` as a data source for queueDepth/queueActiveJobs.
 * Call once per queue, at worker startup (apps/worker/src/index.ts) —
 * before that, both gauges simply report no series for a queue that
 * hasn't been registered yet, same as any other metric with no
 * observations.
 */
export function registerQueueForMetrics(queue: QueueCountsSource): void {
  sources.push(queue);
}

/** Test-only reset — mirrors @raas/observability's resetErrorTrackerForTesting. */
export function resetQueueMetricsRegistrationsForTesting(): void {
  sources = [];
}

const queueLabelNames = ["queue"] as const;

/**
 * Jobs waiting to be processed — waiting + delayed + prioritized +
 * waiting-children, the exact same definition BullMQ's own
 * `Queue#count()` uses (see its doc comment); recomputed here from
 * getJobCounts() instead of calling count() only so this file only needs
 * one BullMQ method (getJobCounts) across both gauges, not two — see
 * queueActiveJobs's own doc comment for why that still costs a separate
 * Redis round-trip per queue per scrape, not a shared one.
 *
 * Point-in-time state, not an event count — pulled fresh from BullMQ on
 * every scrape via `collect()` (prom-client awaits an async collect
 * before serving a scrape — see registry.ts's own doc comment on
 * collectDefaultMetrics for the same "pull real external state at scrape
 * time" shape), rather than tracked incrementally through Worker events
 * the way the Counters in ingestion-metrics.ts are. BullMQ has no event
 * for "a job is now sitting in the waiting list" to increment/decrement
 * against — only Worker-observed state transitions (active, completed,
 * failed) — so a gauge sampled at scrape time is the only way to reflect
 * current queue depth at all.
 */
export const queueDepth = new Gauge({
  name: "raas_queue_depth",
  help: "Jobs waiting to be processed in a queue (waiting + delayed + prioritized + waiting-children), sampled at scrape time",
  labelNames: queueLabelNames,
  registers: [registry],
  async collect() {
    for (const source of sources) {
      const counts = await source.getJobCounts();
      const depth = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0) + (counts["waiting-children"] ?? 0);
      this.set({ queue: source.name }, depth);
    }
  },
});

/**
 * Jobs currently being processed in a queue — see queueDepth's own doc
 * comment for why this is a gauge sampled at scrape time rather than a
 * counter, and why it recomputes from getJobCounts() rather than sharing
 * a value with queueDepth (each gauge's collect() runs independently;
 * see that comment for why the resulting second Redis round-trip per
 * queue per scrape is an accepted, deliberately-not-optimized tradeoff).
 */
export const queueActiveJobs = new Gauge({
  name: "raas_queue_active_jobs",
  help: "Jobs currently being processed in a queue, sampled at scrape time",
  labelNames: queueLabelNames,
  registers: [registry],
  async collect() {
    for (const source of sources) {
      const counts = await source.getJobCounts();
      this.set({ queue: source.name }, counts.active ?? 0);
    }
  },
});
