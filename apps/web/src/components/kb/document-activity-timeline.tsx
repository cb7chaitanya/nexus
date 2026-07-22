import { formatDistanceToNow } from "date-fns";
import { CheckCircle2Icon, ClockIcon, Loader2Icon, TriangleAlertIcon, UploadIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Document, DocumentStatus } from "@/lib/types";

const STATUS_META: Record<DocumentStatus, { icon: typeof ClockIcon; label: string; tone: string }> = {
  PENDING_UPLOAD: { icon: UploadIcon, label: "uploaded", tone: "text-muted-foreground" },
  QUEUED: { icon: ClockIcon, label: "queued for processing", tone: "text-muted-foreground" },
  PROCESSING: { icon: Loader2Icon, label: "processing", tone: "text-warning" },
  READY: { icon: CheckCircle2Icon, label: "finished processing", tone: "text-success" },
  FAILED: { icon: TriangleAlertIcon, label: "failed", tone: "text-destructive" },
  DELETED: { icon: TriangleAlertIcon, label: "deleted", tone: "text-muted-foreground" },
};

const MAX_ITEMS = 8;

/**
 * A "recent activity" feed synthesized from each document's own timestamps — there's
 * no backend event log to read from, so this is the honest version of an ingestion
 * timeline: the most recently status-changed documents, not a true audit trail.
 */
export function DocumentActivityTimeline({ documents }: { documents: Document[] }) {
  const items = [...documents]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MAX_ITEMS);

  if (items.length === 0) return null;

  return (
    <div className="space-y-3">
      {items.map((doc) => {
        const meta = STATUS_META[doc.status];
        const Icon = meta.icon;
        return (
          <div key={doc.id} className="flex items-start gap-3 text-sm">
            <Icon
              className={cn(
                "mt-0.5 size-3.5 shrink-0",
                meta.tone,
                doc.status === "PROCESSING" && "animate-spin",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate">
                <span className="font-medium">{doc.fileName}</span>{" "}
                <span className="text-muted-foreground">{meta.label}</span>
              </p>
              {doc.status === "FAILED" && doc.failureReason && (
                <p className="mt-0.5 truncate text-xs text-destructive/80">{doc.failureReason}</p>
              )}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatDistanceToNow(new Date(doc.updatedAt), { addSuffix: true })}
            </span>
          </div>
        );
      })}
    </div>
  );
}
