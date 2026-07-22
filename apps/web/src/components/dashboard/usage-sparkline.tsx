"use client";

import { motion } from "framer-motion";

import { aggregateDailyUsage } from "@/lib/usage";
import type { UsageBreakdownRow } from "@/lib/types";

export function UsageSparkline({ breakdown }: { breakdown: UsageBreakdownRow[] }) {
  const daily = aggregateDailyUsage(breakdown, 14);
  const max = Math.max(1, ...daily.map(([, tokens]) => tokens));

  if (daily.length === 0) {
    return <div className="flex h-14 items-center text-xs text-muted-foreground">No usage yet</div>;
  }

  return (
    <div className="flex h-14 items-end gap-1">
      {daily.map(([date, tokens], index) => (
        <motion.div
          key={date}
          initial={{ scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={{ duration: 0.3, delay: index * 0.02, ease: "easeOut" }}
          style={{ height: `${Math.max(6, (tokens / max) * 100)}%`, transformOrigin: "bottom" }}
          className="flex-1 rounded-t-sm bg-primary/80"
          title={`${date} · ${tokens.toLocaleString()} tokens`}
        />
      ))}
    </div>
  );
}
