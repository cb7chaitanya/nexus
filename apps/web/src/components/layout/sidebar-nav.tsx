"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { primaryNavItems } from "@/components/layout/nav-config";

export function SidebarNav({
  onNavigate,
  scope = "desktop",
}: {
  onNavigate?: () => void;
  /** Distinguishes the desktop sidebar from the mobile sheet's copy, which mount simultaneously — a shared layoutId across both would fight over the same shared-element animation. */
  scope?: "desktop" | "mobile";
}) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5 px-3">
      {primaryNavItems.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={`sidebar-active-rail-${scope}`}
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
                className="absolute -left-3 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary"
              />
            )}
            <item.icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
