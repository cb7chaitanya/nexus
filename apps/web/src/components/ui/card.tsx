import * as React from "react";

import { cn } from "@/lib/utils";

function Card({
  className,
  interactive = false,
  ...props
}: React.ComponentProps<"div"> & {
  /** Opt-in hover lift/elevation for cards that are themselves a link/click target — leave off for purely informational cards (stats, settings panels). */
  interactive?: boolean;
}) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-4 rounded-xl border border-border bg-card text-card-foreground shadow-xs transition-all duration-200",
        interactive && "hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-col gap-1 px-5 pt-5", className)}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("text-sm font-semibold leading-none", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("absolute right-5 top-5", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-5", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-5 pb-5", className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter };
