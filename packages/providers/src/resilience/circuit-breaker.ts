export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open (rejecting immediately, no call
   * attempted) before allowing one trial call through. */
  cooldownMs: number;
}

/** Thrown instead of calling the wrapped function at all, while the
 * circuit is open. Distinct from whatever error the wrapped function
 * itself would raise — callers can tell "the provider is being given a
 * break" apart from "this specific call failed". */
export class CircuitBreakerOpenError extends Error {
  constructor(message = "Circuit breaker is open — the provider has been failing repeatedly") {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

/**
 * Standard closed/open/half-open circuit breaker. Exists so a provider
 * that's clearly down (many consecutive failures) stops being hammered
 * with new attempts — each one still paying a full connection/timeout
 * cost — for a cooldown period, instead of every caller independently
 * discovering the same outage the slow way. One trial call is let
 * through after the cooldown (half-open); success closes the circuit,
 * failure reopens it with a fresh cooldown.
 *
 * Deliberately generic (not OpenAI-specific) — wraps any async
 * operation. See llm/openai.ts for how OpenAIChatProvider uses one to
 * wrap connection establishment specifically, not the whole streamed
 * response.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(private readonly options: CircuitBreakerOptions) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.openedAt < this.options.cooldownMs) {
        throw new CircuitBreakerOpenError();
      }
      this.state = "half-open";
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.state === "half-open" || this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}
