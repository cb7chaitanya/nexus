import { CheckCircle2Icon, ClockIcon, Loader2Icon, TriangleAlertIcon, UploadIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { DocumentStatus } from "@/lib/types";

const STATUS_CONFIG: Record<
  DocumentStatus,
  { label: string; variant: "default" | "secondary" | "success" | "warning" | "destructive" | "outline"; icon: typeof ClockIcon; spin?: boolean }
> = {
  PENDING_UPLOAD: { label: "Pending upload", icon: UploadIcon, variant: "outline" },
  QUEUED: { label: "Queued", icon: ClockIcon, variant: "secondary" },
  PROCESSING: { label: "Processing", icon: Loader2Icon, variant: "warning", spin: true },
  READY: { label: "Ready", icon: CheckCircle2Icon, variant: "success" },
  FAILED: { label: "Failed", icon: TriangleAlertIcon, variant: "destructive" },
  DELETED: { label: "Deleted", icon: TriangleAlertIcon, variant: "outline" },
};

export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <Badge variant={config.variant}>
      <Icon className={config.spin ? "animate-spin" : undefined} />
      {config.label}
    </Badge>
  );
}
