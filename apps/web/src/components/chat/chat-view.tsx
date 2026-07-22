"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDownIcon, HistoryIcon, PlusIcon } from "lucide-react";

import { useChat } from "@/hooks/use-chat";
import { useDocuments } from "@/hooks/use-documents";
import { ChatHistorySidebar } from "@/components/chat/chat-history-sidebar";
import { ChatHistoryContent } from "@/components/chat/chat-history-content";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { MessageBubble, StreamErrorNotice } from "@/components/chat/message-bubble";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "@/components/ui/visually-hidden";
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
  const {
    messages,
    sendMessage,
    stop,
    isStreaming,
    streamError,
    retryLastMessage,
    conversationId: activeId,
  } = useChat({
    knowledgeBaseId: knowledgeBase.id,
    organizationId,
    conversationId,
    initialMessages,
  });

  const documents = useDocuments(knowledgeBase.id, organizationId);
  const fileNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const doc of documents.data?.data ?? []) map[doc.id] = doc.fileName;
    return map;
  }, [documents.data]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);

  useEffect(() => {
    if (stickToBottom) {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        // Instant while tokens are actively streaming in (called on every
        // token — a `smooth` scroll here queues overlapping animations
        // and feels janky); smooth only for discrete jumps once a stream
        // has finished.
        behavior: isStreaming ? "auto" : "smooth",
      });
    }
  }, [messages, stickToBottom, isStreaming]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom < 80);
  }

  function scrollToBottom() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    setStickToBottom(true);
  }

  const lastMessage = messages[messages.length - 1];

  return (
    <div className="flex h-[calc(100vh-3.5rem)] md:h-screen">
      <ChatHistorySidebar
        knowledgeBaseId={knowledgeBase.id}
        organizationId={organizationId}
        activeConversationId={activeId}
      />

      <Sheet open={mobileHistoryOpen} onOpenChange={setMobileHistoryOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <VisuallyHidden>
            <SheetTitle>Conversation history</SheetTitle>
          </VisuallyHidden>
          <ChatHistoryContent
            knowledgeBaseId={knowledgeBase.id}
            organizationId={organizationId}
            activeConversationId={activeId}
            onNavigate={() => setMobileHistoryOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-3 py-2 md:hidden">
          <Button variant="ghost" size="sm" onClick={() => setMobileHistoryOpen(true)}>
            <HistoryIcon /> History
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/kb/${knowledgeBase.id}/chat`}>
              <PlusIcon /> New chat
            </Link>
          </Button>
        </div>

        {messages.length === 0 ? (
          <ChatEmptyState knowledgeBaseName={knowledgeBase.name} onSuggestionClick={sendMessage} />
        ) : (
          <div className="relative flex-1 overflow-hidden">
            <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto scrollbar-thin">
              <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-6">
                {messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    fileNames={fileNames}
                    knowledgeBaseId={knowledgeBase.id}
                    isLast={message.id === lastMessage?.id}
                    onRegenerate={message.role === "ASSISTANT" ? retryLastMessage : undefined}
                  />
                ))}
                {streamError && !isStreaming && (
                  <StreamErrorNotice message={streamError} onRetry={retryLastMessage} />
                )}
              </div>
            </div>

            {!stickToBottom && (
              <button
                type="button"
                onClick={scrollToBottom}
                className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs shadow-md transition-colors hover:bg-accent"
              >
                <ArrowDownIcon className="size-3.5" /> Scroll to bottom
              </button>
            )}
          </div>
        )}
        <ChatComposer onSend={sendMessage} onStop={stop} isStreaming={isStreaming} />
      </div>
    </div>
  );
}
