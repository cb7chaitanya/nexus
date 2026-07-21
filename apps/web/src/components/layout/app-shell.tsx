"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { MenuIcon, SearchIcon } from "lucide-react";

import { Logo } from "@/components/logo";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { UserMenu } from "@/components/layout/user-menu";
import { CommandPalette } from "@/components/layout/command-palette";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { VisuallyHidden } from "@/components/ui/visually-hidden";

function CommandPaletteTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/30 px-2.5 py-1.5 text-left text-sm text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
    >
      <SearchIcon className="size-3.5" />
      <span className="flex-1">Search…</span>
      <kbd className="rounded border border-sidebar-border bg-sidebar px-1.5 py-0.5 font-mono text-[10px] text-sidebar-foreground/50">
        ⌘K
      </kbd>
    </button>
  );
}

function SidebarContents({
  onNavigate,
  onOpenCommandPalette,
}: {
  onNavigate?: () => void;
  onOpenCommandPalette: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-4 py-4">
      <div className="px-4">
        <Link href="/dashboard">
          <Logo />
        </Link>
      </div>
      <div className="space-y-2 px-3">
        <OrgSwitcher />
        <CommandPaletteTrigger onOpen={onOpenCommandPalette} />
      </div>
      <div className="flex-1 overflow-y-auto">
        <SidebarNav onNavigate={onNavigate} />
      </div>
      <div className="px-3">
        <UserMenu />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
        <SidebarContents onOpenCommandPalette={() => setCommandOpen(true)} />
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0">
          <VisuallyHidden>
            <SheetTitle>Navigation</SheetTitle>
          </VisuallyHidden>
          <SidebarContents
            onNavigate={() => setMobileNavOpen(false)}
            onOpenCommandPalette={() => {
              setMobileNavOpen(false);
              setCommandOpen(true);
            }}
          />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 md:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setMobileNavOpen(true)}>
            <MenuIcon />
          </Button>
          <Logo />
          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            className="ml-auto flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <SearchIcon className="size-4" />
          </button>
        </header>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}
