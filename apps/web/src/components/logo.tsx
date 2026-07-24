import { cn } from "@/lib/utils";
import { NexusMark } from "@/components/icons/nexus-mark";

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <NexusMark className="size-3.5" />
      </span>
      <span>Nexus</span>
    </div>
  );
}
