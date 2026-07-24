"use client";

import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";

import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/chat/code-block";

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "cURL",
  javascript: "JavaScript",
  python: "Python",
  json: "JSON",
};

const components: Components = { pre: CodeBlock };

/** Renders one fenced code block per language and lets the reader switch
 * between them — reuses the exact same ReactMarkdown + rehype-highlight +
 * CodeBlock pipeline chat responses already render through, so a docs code
 * sample and a chat code block are visually identical, not a second
 * parallel implementation. */
export function CodeTabs({ examples }: { examples: Partial<Record<"bash" | "javascript" | "python" | "json", string>> }) {
  const languages = Object.keys(examples) as (keyof typeof examples)[];
  const [active, setActive] = useState(languages[0]!);
  const code = examples[active]!;

  return (
    <div className="mb-4 last:mb-0">
      {languages.length > 1 && (
        <div className="flex gap-1 border-b border-border">
          {languages.map((lang) => (
            <button
              key={lang}
              type="button"
              onClick={() => setActive(lang)}
              className={cn(
                "border-b-2 px-3 py-2 text-small font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                active === lang
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {LANGUAGE_LABELS[lang] ?? lang}
            </button>
          ))}
        </div>
      )}
      <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={components}>
        {`\`\`\`${active}\n${code}\n\`\`\``}
      </ReactMarkdown>
    </div>
  );
}
