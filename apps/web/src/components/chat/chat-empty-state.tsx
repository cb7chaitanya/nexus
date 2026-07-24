"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Loader2Icon, MessageCircleIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";

import { SubTitle } from "@/components/ui/typography";

const suggestions = [
  "Summarize the key points across these documents",
  "What are the most important dates or deadlines mentioned?",
  "Are there any contradictions between the documents?",
];

export function ChatEmptyState({
  knowledgeBaseName,
  documentStatus,
  onSuggestionClick,
}: {
  knowledgeBaseName: string;
  documentStatus: "none" | "processing" | "ready";
  onSuggestionClick: (text: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <motion.div
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reducedMotion ? { duration: 0 } : { duration: 0.35 }}
      >
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-secondary text-foreground">
          <MessageCircleIcon className="size-5" />
        </div>
        <SubTitle className="mt-4">Ask {knowledgeBaseName} anything</SubTitle>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
          Answers are grounded in your documents and always include their sources.
        </p>
        {documentStatus !== "ready" && (
          <div className="mx-auto mt-4 flex max-w-sm items-center gap-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-left text-xs text-muted-foreground">
            {documentStatus === "none" ? (
              <>
                <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
                This knowledge base has no documents yet — upload one before asking a question.
              </>
            ) : (
              <>
                <Loader2Icon className="size-3.5 shrink-0 animate-spin text-warning" />
                Documents are still being indexed — answers may be incomplete until it finishes.
              </>
            )}
          </div>
        )}
        <motion.div
          className="mx-auto mt-6 flex max-w-md flex-col gap-2"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: reducedMotion ? 0 : 0.06, delayChildren: reducedMotion ? 0 : 0.15 } } }}
        >
          {suggestions.map((suggestion) => (
            <motion.button
              key={suggestion}
              variants={{
                hidden: reducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 },
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
