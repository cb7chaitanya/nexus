"use client";

import { motion } from "framer-motion";
import { MessageCircleIcon, SparklesIcon } from "lucide-react";

const suggestions = [
  "Summarize the key points across these documents",
  "What are the most important dates or deadlines mentioned?",
  "Are there any contradictions between the documents?",
];

export function ChatEmptyState({
  knowledgeBaseName,
  onSuggestionClick,
}: {
  knowledgeBaseName: string;
  onSuggestionClick: (text: string) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <MessageCircleIcon className="size-5" />
        </div>
        <h2 className="mt-4 text-lg font-semibold">Ask {knowledgeBaseName} anything</h2>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
          Answers are grounded in your documents and always include their sources.
        </p>
        <div className="mx-auto mt-6 flex max-w-md flex-col gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => onSuggestionClick(suggestion)}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent/40"
            >
              <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
              {suggestion}
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
