import { ZapIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { UsageSparkline } from "@/components/dashboard/usage-sparkline";
import type { UsageBreakdownRow } from "@/lib/types";

export function UsageSummaryCard({
  requestCount,
  breakdown,
}: {
  requestCount: number;
  breakdown: UsageBreakdownRow[];
}) {
  return (
    <Card className="py-5">
      <CardContent className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-caption uppercase text-muted-foreground">
            <ZapIcon className="size-3.5" /> Requests (30d)
          </div>
          <p className="mt-1.5 text-h2 tabular-nums">{requestCount.toLocaleString()}</p>
        </div>
        <div className="w-32 shrink-0 sm:w-44">
          <UsageSparkline breakdown={breakdown} />
        </div>
      </CardContent>
    </Card>
  );
}
