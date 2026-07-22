"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FileTextIcon } from "lucide-react";

const ANSWER_TEXT = "Enterprise plans include a 30-day money-back guarantee.";
const TYPE_INTERVAL_MS = 18;

export function PipelineAnswerPreview({
  stage,
  reducedMotion,
}: {
  stage: number;
  reducedMotion: boolean;
}) {
  const generating = stage >= 3;
  const cited = stage >= 4;
  const [charCount, setCharCount] = useState(reducedMotion ? ANSWER_TEXT.length : 0);

  useEffect(() => {
    if (reducedMotion) {
      setCharCount(ANSWER_TEXT.length);
      return;
    }
    if (!generating) {
      setCharCount(0);
      return;
    }
    setCharCount(0);
    const id = setInterval(() => {
      setCharCount((count) => {
        if (count >= ANSWER_TEXT.length) {
          clearInterval(id);
          return count;
        }
        return count + 1;
      });
    }, TYPE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [generating, reducedMotion]);

  return (
    <div className="mx-auto max-w-xl">
      <p className="text-xs font-medium text-muted-foreground">Generated answer</p>
      <div className="mt-2 min-h-14 rounded-lg border border-border bg-background px-4 py-3 text-sm">
        {generating ? (
          <span>
            {ANSWER_TEXT.slice(0, charCount)}
            {charCount < ANSWER_TEXT.length && (
              <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-caret-blink bg-current" />
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">Waiting for retrieval to complete…</span>
        )}
      </div>
      <AnimatePresence>
        {cited && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.25 }}
            className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
          >
            <FileTextIcon className="size-3" /> enterprise-terms.pdf · p.4
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
