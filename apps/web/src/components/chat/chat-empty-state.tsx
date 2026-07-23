"use client";

import { motion } from "framer-motion";
import { MessageCircleIcon, SparklesIcon } from "lucide-react";

import { SubTitle } from "@/components/ui/typography";

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
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-secondary text-foreground">
          <MessageCircleIcon className="size-5" />
        </div>
        <SubTitle className="mt-4">Ask {knowledgeBaseName} anything</SubTitle>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
          Answers are grounded in your documents and always include their sources.
        </p>
        <motion.div
          className="mx-auto mt-6 flex max-w-md flex-col gap-2"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.06, delayChildren: 0.15 } } }}
        >
          {suggestions.map((suggestion) => (
            <motion.button
              key={suggestion}
              variants={{
                hidden: { opacity: 0, y: 6 },
                show: { opacity: 1, y: 0 },
              }}
              onClick={() => onSuggestionClick(suggestion)}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2.5 text-left text-sm transition-colors duration-200 hover:border-primary/40 hover:bg-accent/40"
            >
              <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
              {suggestion}
            </motion.button>
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
}
