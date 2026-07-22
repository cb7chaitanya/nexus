import type { UsageBreakdownRow } from "@/lib/types";

/** Sums token usage per calendar day, sorted ascending. `days` keeps only the most recent N. */
export function aggregateDailyUsage(breakdown: UsageBreakdownRow[], days?: number) {
  const byDate = new Map<string, number>();
  for (const row of breakdown) {
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.tokens);
  }
  const sorted = Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b));
  return days ? sorted.slice(-days) : sorted;
}
