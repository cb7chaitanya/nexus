"use client";

import * as React from "react";
import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { cn } from "@/lib/utils";

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return extractText(props.children);
  }
  return "";
}

/**
 * Overrides react-markdown's `pre` for fenced code blocks — rehype-highlight
 * has already wrapped the code in a tree of `.hljs-*` spans by the time
 * this renders, so the copy button reconstructs the raw text by walking
 * that tree rather than assuming `children` is a plain string.
 */
export function CodeBlock({ className, children, ...props }: React.ComponentProps<"pre">) {
  const [copied, setCopied] = useState(false);

  const codeElement = React.isValidElement<{ className?: string }>(children) ? children : null;
  const languageMatch = /language-(\w+)/.exec(codeElement?.props.className ?? "");
  const language = languageMatch?.[1] ?? "text";

  async function handleCopy() {
    await navigator.clipboard.writeText(extractText(children));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-border last:mb-0">
      <div className="flex items-center justify-between bg-muted/60 px-3 py-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        className={cn("overflow-x-auto bg-black/[0.04] p-3 font-mono text-[0.85em] dark:bg-white/5 [&_code]:bg-transparent [&_code]:p-0", className)}
        {...props}
      >
        {children}
      </pre>
    </div>
  );
}
