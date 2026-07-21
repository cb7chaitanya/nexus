"use client";

import { useState } from "react";
import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";

import { useSession } from "@/lib/session-context";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { CreateOrganizationDialog } from "@/components/layout/create-organization-dialog";

export function OrgSwitcher() {
  const { organizations, currentOrganization, setCurrentOrganizationId } = useSession();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
            {currentOrganization.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="flex-1 truncate text-sm font-medium">{currentOrganization.name}</span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {organizations.map((org) => (
            <DropdownMenuItem
              key={org.id}
              onSelect={() => setCurrentOrganizationId(org.id)}
              className="justify-between"
            >
              <span className="flex items-center gap-2 truncate">
                <span
                  className={cn(
                    "flex size-3.5 items-center justify-center",
                    org.id !== currentOrganization.id && "invisible",
                  )}
                >
                  <CheckIcon className="size-3.5" />
                </span>
                <span className="truncate">{org.name}</span>
              </span>
              <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                {org.role}
              </Badge>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <PlusIcon /> Create organization
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateOrganizationDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
