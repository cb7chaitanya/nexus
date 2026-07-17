export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Runs `fn` with an AbortSignal that fires after `timeoutMs`, and turns
 * the resulting abort into a clear TimeoutError rather than whatever
 * generic AbortError/DOMException the aborted operation itself throws.
 * `fn` is responsible for actually wiring the signal through (e.g.
 * `fetch(url, { signal })`) — this helper only owns the clock and the
 * error translation.
 */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new TimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
