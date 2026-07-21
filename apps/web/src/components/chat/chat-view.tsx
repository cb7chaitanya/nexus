"use client";

import { useEffect, useRef, useState } from "react";

import { useChat } from "@/hooks/use-chat";
import { ChatHistorySidebar } from "@/components/chat/chat-history-sidebar";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { MessageBubble, StreamErrorNotice } from "@/components/chat/message-bubble";
import type { KnowledgeBase, Message } from "@/lib/types";

export function ChatView({
  knowledgeBase,
  organizationId,
  conversationId,
  initialMessages,
}: {
  knowledgeBase: KnowledgeBase;
  organizationId: string;
  conversationId?: string;
  initialMessages?: Message[];
}) {
  const { messages, sendMessage, stop, isStreaming, streamError, retryLastMessage, conversationId: activeId } = useChat({
    knowledgeBaseId: knowledgeBase.id,
    organizationId,
    conversationId,
    initialMessages,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    if (stickToBottom) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages, stickToBottom]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom < 80);
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] md:h-screen">
      <ChatHistorySidebar
        knowledgeBaseId={knowledgeBase.id}
        organizationId={organizationId}
        activeConversationId={activeId}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {messages.length === 0 ? (
          <ChatEmptyState knowledgeBaseName={knowledgeBase.name} onSuggestionClick={sendMessage} />
        ) : (
          <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto scrollbar-thin">
            <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
              {streamError && !isStreaming && (
                <StreamErrorNotice message={streamError} onRetry={retryLastMessage} />
              )}
            </div>
          </div>
        )}
        <ChatComposer onSend={sendMessage} onStop={stop} isStreaming={isStreaming} />
      </div>
    </div>
  );
}
