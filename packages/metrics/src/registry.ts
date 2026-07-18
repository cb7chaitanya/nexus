import { Registry, collectDefaultMetrics } from "prom-client";

/**
 * One process-wide registry, shared by every metric this package defines
 * and by whichever app (apps/api, apps/worker) imports this module —
 * prom-client metrics are inherently process-local (there is one Node
 * process per deployable, see docs/architecture.md's modular-monolith
 * decision), so there is nothing to configure per-caller or per-tenant
 * here. A dedicated Registry (not prom-client's global default) so this
 * package never collides with metrics some other dependency might
 * register against the default registry.
 *
 * collectDefaultMetrics adds the standard Node/process metrics (heap
 * usage, event loop lag, GC pauses, open handles, CPU) for free, under
 * the same "raas_" prefix as every metric this package defines — genuine
 * production signal that costs nothing to wire up and that hand-rolled
 * metrics would never think to add.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "raas_" });
