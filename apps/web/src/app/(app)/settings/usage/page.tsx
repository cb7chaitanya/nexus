"use client";

import { CoinsIcon, MessageSquareIcon, ZapIcon } from "lucide-react";

import { useSession } from "@/lib/session-context";
import { useUsage } from "@/hooks/use-usage";
import { StatCard } from "@/components/dashboard/stat-card";
import { UsageChart } from "@/components/settings/usage-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function UsagePage() {
  const { currentOrganization } = useSession();
  const usage = useUsage(currentOrganization.id);

  if (usage.isLoading) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-52 rounded-xl" />
      </div>
    );
  }

  if (!usage.data) return null;

  const { totals, breakdown, period } = usage.data;

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-muted-foreground">
        {new Date(period.from).toLocaleDateString()} – {new Date(period.to).toLocaleDateString()}
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Requests" icon={MessageSquareIcon} value={totals.requestCount.toLocaleString()} />
        <StatCard
          label="Tokens used"
          icon={ZapIcon}
          value={(totals.embeddingTokens + totals.completionTokens).toLocaleString()}
        />
        <StatCard label="Estimated cost" icon={CoinsIcon} value={`$${totals.estimatedCost.toFixed(2)}`} />
      </div>

      <Card className="py-5">
        <CardHeader>
          <CardTitle className="text-base">Daily token usage</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageChart breakdown={breakdown} />
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Cost is an illustrative estimate based on published provider pricing and is not a billing statement.
      </p>
    </div>
  );
}
