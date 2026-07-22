"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { CheckCircle2Icon, Loader2Icon, TriangleAlertIcon } from "lucide-react";

import { listDocuments } from "@/lib/api/documents";
import { documentKeys } from "@/hooks/use-documents";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import type { KnowledgeBase } from "@/lib/types";

const MAX_TRACKED_KBS = 8;

/**
 * Rolls up real per-document status across the org's knowledge bases into a single
 * "ingestion health" signal — deliberately not "uptime"/"latency", since those aren't
 * metrics this backend exposes. Bounded to the first 8 KBs to keep the client-side
 * fan-out small; matches the same cap the dashboard's KB grid already uses.
 */
export function SystemHealthStrip({
  knowledgeBases,
  organizationId,
}: {
  knowledgeBases: KnowledgeBase[];
  organizationId: string;
}) {
  const tracked = knowledgeBases.slice(0, MAX_TRACKED_KBS);

  const results = useQueries({
    queries: tracked.map((kb) => ({
      queryKey: documentKeys(kb.id),
      queryFn: () => listDocuments(kb.id, organizationId),
      enabled: Boolean(kb.id && organizationId),
    })),
  });

  const counts = useMemo(() => {
    let ready = 0;
    let processing = 0;
    let failed = 0;
    for (const result of results) {
      for (const doc of result.data?.data ?? []) {
        if (doc.status === "READY") ready += 1;
        else if (doc.status === "QUEUED" || doc.status === "PROCESSING") processing += 1;
        else if (doc.status === "FAILED") failed += 1;
      }
    }
    return { ready, processing, failed };
  }, [results]);

  if (tracked.length === 0) return null;

  if (results.some((result) => result.isLoading)) {
    return <Skeleton className="h-[60px] rounded-xl" />;
  }

  const healthy = counts.failed === 0;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border px-5 py-4",
        healthy ? "border-success/25 bg-success/5" : "border-warning/25 bg-warning/5",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="relative flex size-2.5">
          {healthy && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
          )}
          <span
            className={cn("relative inline-flex size-2.5 rounded-full", healthy ? "bg-success" : "bg-warning")}
          />
        </span>
        <span className="text-sm font-medium">
          {healthy ? "Ingestion healthy" : "Ingestion needs attention"}
        </span>
      </div>
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <CheckCircle2Icon className="size-3.5 text-success" /> {counts.ready} ready
        </span>
        {counts.processing > 0 && (
          <span className="flex items-center gap-1.5">
            <Loader2Icon className="size-3.5 animate-spin text-warning" /> {counts.processing} processing
          </span>
        )}
        {counts.failed > 0 && (
          <span className="flex items-center gap-1.5">
            <TriangleAlertIcon className="size-3.5 text-destructive" /> {counts.failed} failed
          </span>
        )}
      </div>
    </div>
  );
}
