"use client";

import { useMemo } from "react";
import { format } from "date-fns";

import { aggregateDailyUsage } from "@/lib/usage";
import type { UsageBreakdownRow } from "@/lib/types";

export function UsageChart({ breakdown }: { breakdown: UsageBreakdownRow[] }) {
  const daily = useMemo(() => aggregateDailyUsage(breakdown, 30), [breakdown]);

  const max = Math.max(1, ...daily.map(([, tokens]) => tokens));

  if (daily.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No usage recorded in this period.</p>;
  }

  return (
    <div className="flex h-40 items-end gap-1">
      {daily.map(([date, tokens]) => (
        <div key={date} className="group relative flex-1">
          <div
            className="w-full rounded-t-sm bg-primary/80 transition-colors group-hover:bg-primary"
            style={{ height: `${Math.max(4, (tokens / max) * 100)}%` }}
          />
          <div className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-caption text-background group-hover:block">
            {format(new Date(date), "MMM d")} · {tokens.toLocaleString()} tokens
          </div>
        </div>
      ))}
    </div>
  );
}
