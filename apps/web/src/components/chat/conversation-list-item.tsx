import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { MessageSquareIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Conversation } from "@/lib/types";

export function ConversationListItem({
  conversation,
  href,
  active,
}: {
  conversation: Conversation;
  href: string;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-start gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
      )}
    >
      <MessageSquareIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{conversation.title ?? "New conversation"}</span>
        <span className="block text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(conversation.createdAt), { addSuffix: true })}
        </span>
      </span>
    </Link>
  );
}
