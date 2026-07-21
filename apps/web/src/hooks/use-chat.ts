"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { streamChat } from "@/lib/api/chat";
import { listConversations } from "@/lib/api/conversations";
import { conversationKeys } from "@/hooks/use-conversations";
import { isApiError } from "@/lib/api-error";
import type { Citation, Message } from "@/lib/types";

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

      try {
        await streamChat(
          knowledgeBaseId,
          { organizationId, message: trimmed, conversationId: localConversationId },
          {
            onToken: (delta) => {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m)),
              );
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
