import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <svg viewBox="0 0 24 24" fill="none" className="size-3.5">
          <path
            d="M4 12L10 6M4 12L10 18M4 12H20M20 12L14 6M20 12L14 18"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span>Nexus</span>
    </div>
  );
}
