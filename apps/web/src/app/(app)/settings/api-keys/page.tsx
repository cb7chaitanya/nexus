"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { KeyRoundIcon, PlusIcon, TrashIcon } from "lucide-react";
import { toast } from "sonner";

import { useSession } from "@/lib/session-context";
import { useApiKeys, useRevokeApiKey } from "@/hooks/use-api-keys";
import { CreateApiKeyDialog } from "@/components/settings/create-api-key-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function keyStatus(key: { revokedAt: string | null; expiresAt: string | null }) {
  if (key.revokedAt) return { label: "Revoked", variant: "outline" as const };
  if (key.expiresAt && new Date(key.expiresAt) < new Date()) return { label: "Expired", variant: "outline" as const };
  return { label: "Active", variant: "success" as const };
}

export default function ApiKeysPage() {
  const { currentOrganization } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  const apiKeys = useApiKeys(currentOrganization.id);
  const revokeApiKey = useRevokeApiKey(currentOrganization.id);

  const keys = apiKeys.data?.data ?? [];

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">API keys</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Authenticate programmatic access to your organization&apos;s data.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon /> New key
        </Button>
      </div>

      {apiKeys.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : keys.length === 0 ? (
        <EmptyState
          icon={KeyRoundIcon}
          title="No API keys yet"
          description="Create a key to authenticate requests from your own applications."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon /> New key
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => {
                const status = keyStatus(key);
                return (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{key.prefix}…</TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {key.lastUsedAt ? formatDistanceToNow(new Date(key.lastUsedAt), { addSuffix: true }) : "Never"}
                    </TableCell>
                    <TableCell>
                      {!key.revokedAt && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Revoke ${key.name}`}
                          onClick={() =>
                            toast.promise(revokeApiKey.mutateAsync(key.id), {
                              loading: "Revoking…",
                              success: "Key revoked",
                              error: "Couldn't revoke key",
                            })
                          }
                        >
                          <TrashIcon className="size-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateApiKeyDialog organizationId={currentOrganization.id} open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
