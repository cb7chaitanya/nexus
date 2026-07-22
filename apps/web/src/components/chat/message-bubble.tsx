"use client";

import { memo, useState } from "react";
import { CheckIcon, CopyIcon, RotateCwIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { CitationList } from "@/components/chat/citation-list";
import { TypingIndicator } from "@/components/chat/typing-indicator";
import { Button } from "@/components/ui/button";
import type { DisplayMessage } from "@/hooks/use-chat";

function MessageBubbleImpl({
  message,
  fileNames,
  knowledgeBaseId,
  isLast = false,
  onRegenerate,
}: {
  message: DisplayMessage;
  fileNames?: Record<string, string>;
  knowledgeBaseId: string;
  isLast?: boolean;
  onRegenerate?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "USER";

  async function handleCopy() {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[65ch] rounded-lg bg-muted/60 px-3.5 py-2 text-sm">{message.content}</div>
      </div>
    );
  }

  const showTyping = message.pending && message.content.length === 0;
  const isStreamingText = message.pending && message.content.length > 0;

  return (
    <div className="group flex justify-start">
      <div className="max-w-[68ch] text-foreground">
        {showTyping ? (
          <TypingIndicator />
        ) : (
          <>
            <div className="relative">
              <MarkdownContent
                content={message.content}
                citations={message.citations}
                fileNames={fileNames}
                knowledgeBaseId={knowledgeBaseId}
              />
              {isStreamingText && (
                <span className="animate-caret-blink ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-current align-middle" />
              )}
            </div>
            <CitationList
              citations={message.citations}
              fileNames={fileNames}
              knowledgeBaseId={knowledgeBaseId}
            />
          </>
        )}
        {!message.pending && message.content.length > 0 && (
          <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button variant="ghost" size="icon-sm" className="size-6 text-muted-foreground" onClick={handleCopy}>
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </Button>
            {isLast && onRegenerate && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 text-muted-foreground"
                onClick={onRegenerate}
                title="Regenerate"
              >
                <RotateCwIcon className="size-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);

export function StreamErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={cn("mx-auto flex max-w-md items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive")}>
      <span className="flex-1">{message}</span>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
          Retry
        </Button>
      )}
    </div>
  );
}
