import { cn } from "@/lib/utils";

/** An editorial metric cell — no icon, no border of its own. Compose 2+ of
 * these inside a `divide-x`/`divide-y` + `rounded-xl border` wrapper so the
 * divider lines, not per-cell boxes, carry the separation. */
export function StatCard({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 flex-1 px-5 py-4", className)}>
      <p className="text-caption uppercase text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-h2 tabular-nums">{value}</p>
    </div>
  );
}
