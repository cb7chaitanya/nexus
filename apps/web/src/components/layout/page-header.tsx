import type { ReactNode } from "react";

import { PageTitle } from "@/components/ui/typography";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-border px-6 py-6 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <PageTitle>{title}</PageTitle>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
