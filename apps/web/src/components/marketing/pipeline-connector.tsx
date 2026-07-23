"use client";

import { motion } from "framer-motion";

import { duration, ease, transition } from "@/lib/motion";

export function PipelineConnector({ filled }: { filled: boolean }) {
  return (
    <div className="relative mx-2 h-px min-w-6 flex-1 bg-border">
      <motion.div
        className="absolute inset-y-0 left-0 bg-primary"
        initial={false}
        animate={{ width: filled ? "100%" : "0%" }}
        transition={transition(duration.slow, ease.inOut)}
      >
        <span
          aria-hidden
          className="absolute right-0 top-1/2 size-2 -translate-y-1/2 translate-x-1/2 rounded-full bg-primary shadow-[0_0_8px_1px] shadow-primary/60"
        />
      </motion.div>
    </div>
  );
}
