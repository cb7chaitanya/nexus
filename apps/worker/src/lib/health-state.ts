// Deliberately a tiny piece of module-level state, not a database row or
// Redis key — "when did this specific process last do something useful"
// is process-local by definition (a fresh deploy/restart legitimately
// resets it to null, and it should), so there's nothing here that needs
// to survive a restart or be visible across workers. Read by
// health-server.ts, written by index.ts's Worker "completed" handlers.
let lastSuccessfulJobAt: Date | null = null;

export function recordJobSuccess(at: Date = new Date()): void {
  lastSuccessfulJobAt = at;
}

export function getLastSuccessfulJobAt(): Date | null {
  return lastSuccessfulJobAt;
}

/** Test-only reset — health-server.test.ts exercises both "a job has run"
 * and "no job has run yet" states, and module-level state would otherwise
 * leak between those cases depending on test order. */
export function resetHealthStateForTesting(): void {
  lastSuccessfulJobAt = null;
}
