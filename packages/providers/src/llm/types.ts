export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Real, billed token counts for one completion — as reported by the
 * provider itself (see OpenAIChatProvider's stream_options.include_usage
 * usage), not an estimate. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * What streamCompletion returns: still directly usable in a `for await`
 * loop exactly like a plain AsyncIterable<string> (apps/api's chat
 * endpoint forwards each yielded delta straight into an SSE `token` event
 * as it arrives — see apps/api/src/routes/chat.ts), plus a `usage` promise
 * that resolves once the stream has been fully consumed — real token
 * counts when the provider reported them, `null` when it didn't (a
 * provider/response that doesn't support usage reporting; callers must
 * have a fallback, never assume this is always present — see
 * apps/api/src/lib/token-accounting.ts). Deliberately not a value only
 * available after `for await` completes via some other side channel: a
 * promise keeps this composable and testable without forcing every caller
 * to restructure its loop.
 */
export interface CompletionStream extends AsyncIterable<string> {
  readonly usage: Promise<TokenUsage | null>;
}

/**
 * Common interface every chat/completion provider implements. Streaming
 * (not a single Promise<string>) is the contract, not an implementation
 * detail: apps/api's chat endpoint forwards each yielded delta straight
 * into an SSE `token` event as it arrives (see apps/api/src/routes/chat.ts)
 * — buffering the whole response before returning it would defeat the
 * point of a streamed chat endpoint.
 */
export interface LLMProvider {
  streamCompletion(messages: LLMMessage[]): CompletionStream;
}
