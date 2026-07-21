"use client";

import { use, useMemo } from "react";

import { useSession } from "@/lib/session-context";
import { useKnowledgeBase } from "@/hooks/use-knowledge-bases";
import { useMessages } from "@/hooks/use-conversations";
import { ChatView } from "@/components/chat/chat-view";
import { Skeleton } from "@/components/ui/skeleton";

export default function ChatPage({
  params,
}: {
  params: Promise<{ id: string; conversationId?: string[] }>;
}) {
  const { id, conversationId: conversationIdParam } = use(params);
  const conversationId = conversationIdParam?.[0];
  const { currentOrganization } = useSession();

  const kb = useKnowledgeBase(id, currentOrganization.id);
  const messages = useMessages(conversationId ?? "", currentOrganization.id);

  const initialMessages = useMemo(() => {
    if (!messages.data) return undefined;
    return [...messages.data.data].reverse();
  }, [messages.data]);

  if (kb.isLoading || (conversationId && messages.isLoading)) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Skeleton className="h-10 w-64" />
      </div>
    );
  }

  if (!kb.data) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Knowledge base not found.
      </div>
    );
  }

  return (
    <ChatView
      knowledgeBase={kb.data}
      organizationId={currentOrganization.id}
      conversationId={conversationId}
      initialMessages={initialMessages}
    />
  );
}
