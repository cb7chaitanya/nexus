import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/chat/code-block";

const components: Components = {
  p: ({ className, ...props }) => <p className={cn("mb-3 last:mb-0 leading-relaxed", className)} {...props} />,
  ul: ({ className, ...props }) => (
    <ul className={cn("mb-3 list-disc space-y-1 pl-5 last:mb-0", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("mb-3 list-decimal space-y-1 pl-5 last:mb-0", className)} {...props} />
  ),
  li: ({ className, ...props }) => <li className={cn("leading-relaxed", className)} {...props} />,
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
    <h1 className={cn("mb-2 mt-4 text-base font-semibold first:mt-0", className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={cn("mb-2 mt-4 text-sm font-semibold first:mt-0", className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={cn("mb-1.5 mt-3 text-sm font-semibold first:mt-0", className)} {...props} />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn("mb-3 border-l-2 border-border pl-3 italic text-muted-foreground last:mb-0", className)}
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
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th className={cn("border border-border px-2 py-1 text-left font-medium", className)} {...props} />
  ),
  td: ({ className, ...props }) => <td className={cn("border border-border px-2 py-1", className)} {...props} />,
};

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
