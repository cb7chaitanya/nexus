import { API_URL } from "@/lib/config";
import { ApiError } from "@/lib/api-error";
import type { ApiErrorBody, Citation } from "@/lib/types";

export interface ChatStreamCallbacks {
  onToken: (text: string) => void;
  onCitations: (citations: Citation[]) => void;
  onStreamError: (message: string) => void;
}

/**
 * Streams a chat response over SSE. Pre-stream failures (auth, validation,
 * rate limit, 404 KB) surface as a normal ApiError throw; once the stream
 * starts, only `event: error` (non-fatal — the answer may already be
 * fully rendered) is reported via the onStreamError callback.
 *
 * There is no `event: done` — stream end (this function resolving) is the
 * only completion signal.
 */
export async function streamChat(
  knowledgeBaseId: string,
  input: { organizationId: string; message: string; conversationId?: string },
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}/kb/${knowledgeBaseId}/chat`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });

  if (!res.ok) {
    const contentType = res.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? ((await res.json()) as ApiErrorBody)
      : undefined;
    throw new ApiError(res.status, payload?.error ?? { message: res.statusText });
  }

  if (!res.body) {
    throw new Error("Chat response had no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      dispatchSseEvent(rawEvent, callbacks);
    }
  }
}

function dispatchSseEvent(raw: string, callbacks: ChatStreamCallbacks) {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (dataLines.length === 0) return;

  const data = JSON.parse(dataLines.join("\n"));

  switch (eventName) {
    case "token":
      callbacks.onToken(data.text as string);
      break;
    case "citations":
      callbacks.onCitations(data.citations as Citation[]);
      break;
    case "error":
      callbacks.onStreamError(data.message as string);
      break;
  }
}
