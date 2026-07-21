"use client";

import Link from "next/link";
import { PlusIcon } from "lucide-react";

import { useConversations } from "@/hooks/use-conversations";
import { ConversationListItem } from "@/components/chat/conversation-list-item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function ChatHistorySidebar({
  knowledgeBaseId,
  organizationId,
  activeConversationId,
}: {
  knowledgeBaseId: string;
  organizationId: string;
  activeConversationId?: string;
}) {
  const conversations = useConversations(organizationId, knowledgeBaseId);
  const items = conversations.data?.data ?? [];

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border md:flex">
      <div className="p-3">
        <Button variant="outline" size="sm" className="w-full justify-start" asChild>
          <Link href={`/kb/${knowledgeBaseId}/chat`}>
            <PlusIcon /> New chat
          </Link>
        </Button>
      </div>
      <ScrollArea className="flex-1 px-2 pb-3">
        {conversations.isLoading ? (
          <div className="space-y-1.5 px-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-md" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="px-2.5 py-4 text-xs text-muted-foreground">No conversations yet.</p>
        ) : (
          <div className="space-y-0.5">
            {items.map((conversation) => (
              <ConversationListItem
                key={conversation.id}
                conversation={conversation}
                href={`/kb/${knowledgeBaseId}/chat/${conversation.id}`}
                active={conversation.id === activeConversationId}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  );
}
