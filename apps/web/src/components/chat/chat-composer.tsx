"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const MAX_LENGTH = 4000;
const WARN_THRESHOLD = MAX_LENGTH * 0.9;

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
  const [length, setLength] = useState(0);

  function submit() {
    const value = textareaRef.current?.value ?? "";
    if (!value.trim() || isStreaming) return;
    onSend(value);
    if (textareaRef.current) {
      textareaRef.current.value = "";
      textareaRef.current.style.height = "auto";
    }
    setLength(0);
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
    setLength(el.value.length);
  }

  return (
    <div className="border-t border-border bg-background p-4">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-input bg-card px-3 py-2 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder="Ask anything about your documents…"
          disabled={disabled}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          maxLength={MAX_LENGTH}
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
      <div className="mx-auto mt-2 flex max-w-3xl items-center justify-center gap-3 text-small text-muted-foreground">
        <p className="text-center">
          <kbd className="rounded border border-border px-1 py-0.5 font-mono text-caption">↵</kbd> to send ·{" "}
          <kbd className="rounded border border-border px-1 py-0.5 font-mono text-caption">⇧↵</kbd> for a new line
        </p>
        {length >= WARN_THRESHOLD && (
          <span className={cn(length >= MAX_LENGTH && "text-destructive")}>
            {length}/{MAX_LENGTH}
          </span>
        )}
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl text-center text-small text-muted-foreground">
        Answers may be incomplete or inaccurate — always verify against the cited sources.
      </p>
    </div>
  );
}
