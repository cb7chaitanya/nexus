"use client";

import { useRouter } from "next/navigation";
import {
  BarChart3Icon,
  DatabaseIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  PlusIcon,
  UsersIcon,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useSession } from "@/lib/session-context";
import { useKnowledgeBases } from "@/hooks/use-knowledge-bases";

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { currentOrganization } = useSession();
  const knowledgeBases = useKnowledgeBases(currentOrganization.id);
  const kbs = knowledgeBases.data?.data ?? [];

  function go(path: string) {
    router.push(path);
    onOpenChange(false);
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command palette" description="Jump to a page, knowledge base, or action">
      <CommandInput placeholder="Search or jump to…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigate">
          <CommandItem value="dashboard" onSelect={() => go("/dashboard")}>
            <LayoutDashboardIcon /> Dashboard
          </CommandItem>
          <CommandItem value="knowledge bases" onSelect={() => go("/kb")}>
            <DatabaseIcon /> Knowledge bases
          </CommandItem>
          <CommandItem value="usage" onSelect={() => go("/settings/usage")}>
            <BarChart3Icon /> Usage
          </CommandItem>
          <CommandItem value="organization settings members" onSelect={() => go("/settings/organization")}>
            <UsersIcon /> Organization settings
          </CommandItem>
          <CommandItem value="api keys" onSelect={() => go("/settings/api-keys")}>
            <KeyRoundIcon /> API keys
          </CommandItem>
        </CommandGroup>

        {kbs.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Knowledge bases">
              {kbs.map((kb) => (
                <CommandItem key={kb.id} value={kb.name} onSelect={() => go(`/kb/${kb.id}`)}>
                  <DatabaseIcon /> {kb.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem value="new knowledge base create" onSelect={() => go("/kb")}>
            <PlusIcon /> New knowledge base
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
