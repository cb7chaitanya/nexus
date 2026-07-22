"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { streamChat } from "@/lib/api/chat";
import { listConversations } from "@/lib/api/conversations";
import { conversationKeys } from "@/hooks/use-conversations";
import { isApiError } from "@/lib/api-error";
import type { Citation, Message } from "@/lib/types";

// Target render cadence for streamed tokens — smooth enough to still read
// as "typing," while cutting the render/re-parse count far below one per
// raw SSE token at typical provider throughput.
const FLUSH_INTERVAL_MS = 60;

export interface DisplayMessage {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  citations: Citation[];
  createdAt: string;
  pending?: boolean;
}

function toDisplayMessage(message: Message): DisplayMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    citations: message.citations,
    createdAt: message.createdAt,
  };
}

export function useChat({
  knowledgeBaseId,
  organizationId,
  conversationId,
  initialMessages,
}: {
  knowledgeBaseId: string;
  organizationId: string;
  conversationId?: string;
  initialMessages?: Message[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [localConversationId, setLocalConversationId] = useState(conversationId);
  const [messages, setMessages] = useState<DisplayMessage[]>(
    initialMessages?.map(toDisplayMessage) ?? [],
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastUserMessageRef = useRef<string | null>(null);
  // Buffers raw SSE token deltas and flushes them into React state at most
  // every FLUSH_INTERVAL_MS via requestAnimationFrame, instead of calling
  // setMessages (and triggering a full markdown re-parse) on every single
  // token — a chat provider can emit far more token events per second than
  // the UI needs to visibly update at.
  const bufferRef = useRef("");
  const flushHandleRef = useRef<number | null>(null);
  const lastFlushRef = useRef(0);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;

      lastUserMessageRef.current = trimmed;
      setStreamError(null);

      const userMessage: DisplayMessage = {
        id: crypto.randomUUID(),
        role: "USER",
        content: trimmed,
        citations: [],
        createdAt: new Date().toISOString(),
      };
      const assistantId = crypto.randomUUID();

      setMessages((prev) => [
        ...prev,
        userMessage,
        { id: assistantId, role: "ASSISTANT", content: "", citations: [], createdAt: new Date().toISOString(), pending: true },
      ]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      bufferRef.current = "";
      lastFlushRef.current = 0;

      function flushBuffer() {
        if (flushHandleRef.current != null) {
          cancelAnimationFrame(flushHandleRef.current);
          flushHandleRef.current = null;
        }
        const pending = bufferRef.current;
        bufferRef.current = "";
        if (pending) {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + pending } : m)));
        }
      }

      function scheduleFlush() {
        if (flushHandleRef.current != null) return;
        flushHandleRef.current = requestAnimationFrame(function tick(now) {
          if (now - lastFlushRef.current < FLUSH_INTERVAL_MS) {
            flushHandleRef.current = requestAnimationFrame(tick);
            return;
          }
          lastFlushRef.current = now;
          flushHandleRef.current = null;
          const pending = bufferRef.current;
          bufferRef.current = "";
          if (pending) {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + pending } : m)));
          }
        });
      }

      try {
        await streamChat(
          knowledgeBaseId,
          { organizationId, message: trimmed, conversationId: localConversationId },
          {
            onToken: (delta) => {
              bufferRef.current += delta;
              scheduleFlush();
            },
            onCitations: (citations) => {
              setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, citations } : m)));
            },
            onStreamError: (message) => {
              setStreamError(message);
            },
          },
          controller.signal,
        );

        // Any buffered delta not yet flushed must land before marking the
        // message no-longer-pending, or trailing text is silently dropped.
        flushBuffer();
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)));

        if (!localConversationId) {
          const list = await listConversations(organizationId, knowledgeBaseId);
          const newest = list.data[0];
          if (newest) {
            setLocalConversationId(newest.id);
            router.replace(`/kb/${knowledgeBaseId}/chat/${newest.id}`, { scroll: false });
          }
        }
        queryClient.invalidateQueries({ queryKey: conversationKeys(organizationId).list(knowledgeBaseId) });
      } catch (error) {
        // Always flush, even on abort — the rAF buffer can hold up to one
        // flush interval's worth of already-received text that would
        // otherwise vanish, a loss the pre-batching implementation never
        // had (every token used to commit to state immediately).
        flushBuffer();
        if (!controller.signal.aborted) {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)));
          setStreamError(
            isApiError(error) ? error.message : "Something went wrong. Please try again.",
          );
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, knowledgeBaseId, organizationId, localConversationId, router, queryClient],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const retryLastMessage = useCallback(() => {
    if (!lastUserMessageRef.current) return;
    const text = lastUserMessageRef.current;
    setMessages((prev) => prev.slice(0, -2));
    void sendMessage(text);
  }, [sendMessage]);

  return {
    messages,
    sendMessage,
    stop,
    isStreaming,
    streamError,
    retryLastMessage,
    conversationId: localConversationId,
  };
}
