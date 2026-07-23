"use client";

import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { duration, ease, transition } from "@/lib/motion";

export function PipelineStage({
  icon: Icon,
  label,
  active,
  complete,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  complete: boolean;
}) {
  const lit = active || complete;
  return (
    <div className="flex shrink-0 flex-col items-center gap-2.5 px-1">
      <motion.div
        animate={{ scale: active ? 1.08 : 1 }}
        transition={transition(duration.moderate, ease.out)}
        className={cn(
          "flex size-10 items-center justify-center rounded-xl border bg-card transition-colors duration-300",
          lit ? "border-primary/50 ring-4 ring-primary/10" : "border-border",
        )}
      >
        <Icon
          className={cn(
            "size-4.5 transition-colors duration-300",
            lit ? "text-primary" : "text-muted-foreground",
          )}
        />
      </motion.div>
      <span
        className={cn(
          "text-small font-medium whitespace-nowrap transition-colors duration-300",
          lit ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </div>
  );
}
