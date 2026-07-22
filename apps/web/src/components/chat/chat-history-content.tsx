"use client";

import Link from "next/link";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";

import { useConversations, useDeleteConversation, useRenameConversation } from "@/hooks/use-conversations";
import { ConversationListItem } from "@/components/chat/conversation-list-item";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Conversation } from "@/lib/types";

function groupByDate(conversations: Conversation[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);

  const groups: { label: string; items: Conversation[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Older", items: [] },
  ];

  for (const conversation of conversations) {
    const created = new Date(conversation.createdAt);
    if (created >= today) groups[0]!.items.push(conversation);
    else if (created >= yesterday) groups[1]!.items.push(conversation);
    else if (created >= weekAgo) groups[2]!.items.push(conversation);
    else groups[3]!.items.push(conversation);
  }
  return groups.filter((g) => g.items.length > 0);
}

export function ChatHistoryContent({
  knowledgeBaseId,
  organizationId,
  activeConversationId,
  onNavigate,
}: {
  knowledgeBaseId: string;
  organizationId: string;
  activeConversationId?: string;
  onNavigate?: () => void;
}) {
  const conversations = useConversations(organizationId, knowledgeBaseId);
  const deleteConversation = useDeleteConversation(organizationId, knowledgeBaseId);
  const renameConversation = useRenameConversation(organizationId, knowledgeBaseId);
  const items = conversations.data?.data ?? [];
  const groups = groupByDate(items);

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <Button variant="outline" size="sm" className="w-full justify-start" asChild>
          <Link href={`/kb/${knowledgeBaseId}/chat`} onClick={onNavigate}>
            <PlusIcon /> New chat
          </Link>
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-3">
        {conversations.isLoading ? (
          <div className="space-y-1.5 px-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-md" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="px-2.5 py-4 text-xs text-muted-foreground">No conversations yet.</p>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
                <div className="space-y-0.5">
                  {group.items.map((conversation) => (
                    <div key={conversation.id} onClick={onNavigate}>
                      <ConversationListItem
                        conversation={conversation}
                        href={`/kb/${knowledgeBaseId}/chat/${conversation.id}`}
                        active={conversation.id === activeConversationId}
                        onDelete={() =>
                          toast.promise(deleteConversation.mutateAsync(conversation.id), {
                            loading: "Deleting…",
                            success: "Conversation deleted",
                            error: "Couldn't delete conversation",
                          })
                        }
                        onRename={(title) =>
                          toast.promise(renameConversation.mutateAsync({ id: conversation.id, title }), {
                            loading: "Renaming…",
                            success: "Conversation renamed",
                            error: "Couldn't rename conversation",
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
