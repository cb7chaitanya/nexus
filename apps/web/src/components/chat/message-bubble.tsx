"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon, RotateCwIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { CitationList } from "@/components/chat/citation-list";
import { TypingIndicator } from "@/components/chat/typing-indicator";
import { Button } from "@/components/ui/button";
import type { DisplayMessage } from "@/hooks/use-chat";

export function MessageBubble({
  message,
  fileNames,
  isLast = false,
  onRegenerate,
}: {
  message: DisplayMessage;
  fileNames?: Record<string, string>;
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
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  const showTyping = message.pending && message.content.length === 0;
  const isStreamingText = message.pending && message.content.length > 0;

  return (
    <div className="group flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-secondary px-4 py-3 text-secondary-foreground">
        {showTyping ? (
          <TypingIndicator />
        ) : (
          <>
            <div className="relative">
              <MarkdownContent content={message.content} />
              {isStreamingText && (
                <span className="animate-caret-blink ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-current align-middle" />
              )}
            </div>
            <CitationList citations={message.citations} fileNames={fileNames} />
          </>
        )}
        {!message.pending && message.content.length > 0 && (
          <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <Button variant="ghost" size="icon-sm" className="size-6" onClick={handleCopy}>
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </Button>
            {isLast && onRegenerate && (
              <Button variant="ghost" size="icon-sm" className="size-6" onClick={onRegenerate} title="Regenerate">
                <RotateCwIcon className="size-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

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
