import * as React from "react";

import { cn } from "@/lib/utils";

/** The single page-level h1 — every route's PageHeader renders exactly one of these. */
function PageTitle({ className, ...props }: React.ComponentProps<"h1">) {
  return <h1 className={cn("text-2xl font-semibold tracking-tight", className)} {...props} />;
}

/**
 * Sub-section / dialog-adjacent heading — collapses what used to be three
 * competing ad hoc combinations (`text-lg font-semibold`, `text-lg
 * font-medium`, `text-base font-semibold`) doing the same job across empty
 * states, 404, and KB detail sub-sections.
 */
function SubTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("text-base font-semibold tracking-tight", className)} {...props} />;
}

export { PageTitle, SubTitle };
