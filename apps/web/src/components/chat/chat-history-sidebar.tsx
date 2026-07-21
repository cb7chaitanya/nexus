"use client";

import { ChatHistoryContent } from "@/components/chat/chat-history-content";

export function ChatHistorySidebar({
  knowledgeBaseId,
  organizationId,
  activeConversationId,
}: {
  knowledgeBaseId: string;
  organizationId: string;
  activeConversationId?: string;
}) {
  return (
    <aside className="hidden w-64 shrink-0 border-r border-border md:block">
      <ChatHistoryContent
        knowledgeBaseId={knowledgeBaseId}
        organizationId={organizationId}
        activeConversationId={activeConversationId}
      />
    </aside>
  );
}
