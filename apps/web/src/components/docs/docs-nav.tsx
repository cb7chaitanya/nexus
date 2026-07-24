"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const SECTIONS: { title: string; items: { href: string; label: string }[] }[] = [
  {
    title: "Get started",
    items: [
      { href: "/docs", label: "Quickstart" },
      { href: "/docs/authentication", label: "Authentication" },
    ],
  },
  {
    title: "Guides",
    items: [
      { href: "/docs/api-keys", label: "API keys" },
      { href: "/docs/documents", label: "Documents" },
      { href: "/docs/chat", label: "Chat" },
      { href: "/docs/citations", label: "Citations" },
      { href: "/docs/pagination", label: "Pagination" },
      { href: "/docs/usage-and-billing", label: "Usage & billing" },
    ],
  },
];

export function DocsNav() {
  const pathname = usePathname();

  return (
    <nav className="space-y-6">
      {SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="px-2 text-caption uppercase text-muted-foreground">{section.title}</p>
          <ul className="mt-1.5 space-y-0.5">
            {section.items.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "block rounded-md px-2 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                      active
                        ? "bg-secondary font-medium text-foreground"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
