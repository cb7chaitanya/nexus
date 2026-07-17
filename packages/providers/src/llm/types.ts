export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
  streamCompletion(messages: LLMMessage[]): AsyncIterable<string>;
}
