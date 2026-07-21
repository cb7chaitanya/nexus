"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const tabs = [
  { href: "/settings/organization", label: "Organization" },
  { href: "/settings/api-keys", label: "API keys" },
  { href: "/settings/usage", label: "Usage" },
  { href: "/settings/profile", label: "Profile" },
];

export function SettingsTabs() {
  const pathname = usePathname();

  return (
    <div className="border-b border-border px-6">
      <nav className="-mb-px flex gap-5 overflow-x-auto">
        {tabs.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "shrink-0 border-b-2 py-3 text-sm font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
