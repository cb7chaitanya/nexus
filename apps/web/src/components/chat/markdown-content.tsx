import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/chat/code-block";
import { InlineCitation } from "@/components/chat/citation-list";
import { remarkCitationMarkers } from "@/components/chat/citation-marker-plugin";
import type { Citation } from "@/lib/types";

function buildComponents(citations: Citation[], fileNames: Record<string, string> | undefined, knowledgeBaseId: string): Components {
  return {
    p: ({ className, ...props }) => <p className={cn("mb-4 leading-[1.7] last:mb-0", className)} {...props} />,
    ul: ({ className, ...props }) => (
      <ul className={cn("mb-4 list-disc space-y-1.5 pl-6 last:mb-0", className)} {...props} />
    ),
    ol: ({ className, ...props }) => (
      <ol className={cn("mb-4 list-decimal space-y-1.5 pl-6 last:mb-0", className)} {...props} />
    ),
    li: ({ className, ...props }) => <li className={cn("leading-[1.7]", className)} {...props} />,
    a: ({ className, ...props }) => (
      <a
        className={cn("font-medium text-primary underline underline-offset-2 hover:no-underline", className)}
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      />
    ),
    strong: ({ className, ...props }) => <strong className={cn("font-semibold", className)} {...props} />,
    h1: ({ className, ...props }) => (
      <h1 className={cn("mt-8 mb-3 text-[1.375rem] font-semibold tracking-tight first:mt-0", className)} {...props} />
    ),
    h2: ({ className, ...props }) => (
      <h2 className={cn("mt-7 mb-2.5 text-[1.1875rem] font-semibold tracking-tight first:mt-0", className)} {...props} />
    ),
    h3: ({ className, ...props }) => (
      <h3 className={cn("mt-6 mb-2 text-[1.0625rem] font-semibold first:mt-0", className)} {...props} />
    ),
    blockquote: ({ className, ...props }) => (
      <blockquote
        className={cn("mb-4 border-l-2 border-primary/30 pl-4 text-foreground/80 italic last:mb-0", className)}
        {...props}
      />
    ),
    // Inline `code` only — fenced blocks render as <pre><code> and are
    // handled entirely by the `pre` override (CodeBlock) below, so this
    // never double-styles a highlighted block's own <code>.
    code: ({ className, ...props }) => (
      <code
        className={cn("rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/10", className)}
        {...props}
      />
    ),
    pre: CodeBlock,
    table: ({ className, ...props }) => (
      <div className="mb-4 overflow-x-auto last:mb-0">
        <table className={cn("w-full border-collapse text-sm", className)} {...props} />
      </div>
    ),
    th: ({ className, ...props }) => (
      <th className={cn("border border-border px-2 py-1 text-left font-medium", className)} {...props} />
    ),
    td: ({ className, ...props }) => <td className={cn("border border-border px-2 py-1", className)} {...props} />,
    // @ts-expect-error — a synthetic tag name from remarkCitationMarkers's
    // `hName`, not a real HTML element; react-markdown's Components type
    // only models the standard HTML tag surface.
    "citation-marker": ({ refid }: { refid: string }) => (
      <InlineCitation refId={refid} citations={citations} fileNames={fileNames} knowledgeBaseId={knowledgeBaseId} />
    ),
  };
}

export function MarkdownContent({
  content,
  citations = [],
  fileNames,
  knowledgeBaseId = "",
}: {
  content: string;
  citations?: Citation[];
  fileNames?: Record<string, string>;
  knowledgeBaseId?: string;
}) {
  return (
    <div className="text-base leading-[1.7]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCitationMarkers]}
        rehypePlugins={[rehypeHighlight]}
        components={buildComponents(citations, fileNames, knowledgeBaseId)}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
