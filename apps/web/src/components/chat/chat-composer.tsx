"use client";

import { useRef, type KeyboardEvent } from "react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export function ChatComposer({
  onSend,
  onStop,
  isStreaming,
  disabled,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const value = textareaRef.current?.value ?? "";
    if (!value.trim() || isStreaming) return;
    onSend(value);
    if (textareaRef.current) {
      textareaRef.current.value = "";
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function handleInput() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  return (
    <div className="border-t border-border bg-background p-4">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-input bg-card px-3 py-2 shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder="Ask anything about your documents…"
          disabled={disabled}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          maxLength={4000}
          className="max-h-[200px] flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />
        {isStreaming ? (
          <Button size="icon" variant="secondary" className="shrink-0" onClick={onStop}>
            <SquareIcon className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button size="icon" className="shrink-0" onClick={submit} disabled={disabled}>
            <ArrowUpIcon />
          </Button>
        )}
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-muted-foreground">
        Answers may be incomplete or inaccurate — always verify against the cited sources.
      </p>
    </div>
  );
}
