import { useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { MessageSquareIcon, MoreHorizontalIcon, PencilIcon, TrashIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Conversation } from "@/lib/types";

export function ConversationListItem({
  conversation,
  href,
  active,
  onDelete,
  onRename,
}: {
  conversation: Conversation;
  href: string;
  active?: boolean;
  onDelete?: () => void;
  onRename?: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title ?? "");

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== conversation.title && onRename) {
      onRename(trimmed);
    }
    setEditing(false);
  }

  function cancel() {
    setDraft(conversation.title ?? "");
    setEditing(false);
  }

  return (
    <div
      className={cn(
        "group/item relative flex items-start gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
      )}
    >
      {editing ? (
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <MessageSquareIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
            className="h-6 flex-1 px-1.5 text-sm"
          />
        </div>
      ) : (
        <Link href={href} className="flex min-w-0 flex-1 items-start gap-2.5">
          <MessageSquareIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{conversation.title ?? "New conversation"}</span>
            <span className="block text-xs text-muted-foreground">
              {formatDistanceToNow(new Date(conversation.createdAt), { addSuffix: true })}
            </span>
          </span>
        </Link>
      )}
      {!editing && (onRename ?? onDelete) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0 opacity-0 group-hover/item:opacity-100 data-[state=open]:opacity-100"
              onClick={(e) => e.preventDefault()}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onRename && (
              <DropdownMenuItem
                onSelect={() => {
                  setDraft(conversation.title ?? "");
                  setEditing(true);
                }}
              >
                <PencilIcon /> Rename
              </DropdownMenuItem>
            )}
            {onRename && onDelete && <DropdownMenuSeparator />}
            {onDelete && (
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <TrashIcon /> Delete conversation
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
