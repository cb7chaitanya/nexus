"use client";

import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { MoreHorizontalIcon, RotateCwIcon, SearchIcon, SearchXIcon, TrashIcon } from "lucide-react";
import { toast } from "sonner";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { DocumentStatusBadge } from "@/components/kb/document-status-badge";
import { useDeleteDocument, useRetryDocument } from "@/hooks/use-documents";
import type { Document, DocumentStatus } from "@/lib/types";

const STATUS_FILTERS: { value: DocumentStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "READY", label: "Ready" },
  { value: "PROCESSING", label: "Processing" },
  { value: "QUEUED", label: "Queued" },
  { value: "FAILED", label: "Failed" },
];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function DocumentsTable({
  documents,
  knowledgeBaseId,
  organizationId,
}: {
  documents: Document[];
  knowledgeBaseId: string;
  organizationId: string;
}) {
  const retryDocument = useRetryDocument(knowledgeBaseId, organizationId);
  const deleteDocument = useDeleteDocument(knowledgeBaseId, organizationId);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<DocumentStatus | "all">("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return documents.filter((document) => {
      if (statusFilter !== "all" && document.status !== statusFilter) return false;
      if (q && !document.fileName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [documents, query, statusFilter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documents…"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as DocumentStatus | "all")}>
          <SelectTrigger size="sm" className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <div className="p-6">
          <EmptyState icon={SearchXIcon} title="No matching documents" description="Try a different search term or status filter." />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((document) => (
          <TableRow key={document.id}>
            <TableCell className="max-w-72 truncate font-medium" title={document.fileName}>
              {document.fileName}
            </TableCell>
            <TableCell>
              <DocumentStatusBadge status={document.status} />
              {document.status === "FAILED" && document.failureReason && (
                <p className="mt-1 max-w-56 truncate text-xs text-muted-foreground" title={document.failureReason}>
                  {document.failureReason}
                </p>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground">{formatBytes(document.sizeBytes)}</TableCell>
            <TableCell className="text-muted-foreground">
              {formatDistanceToNow(new Date(document.createdAt), { addSuffix: true })}
            </TableCell>
            <TableCell>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm">
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {document.status === "FAILED" && (
                    <DropdownMenuItem
                      onSelect={() =>
                        toast.promise(retryDocument.mutateAsync(document.id), {
                          loading: "Retrying…",
                          success: "Document queued for retry",
                          error: "Couldn't retry document",
                        })
                      }
                    >
                      <RotateCwIcon /> Retry
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() =>
                      toast.promise(deleteDocument.mutateAsync(document.id), {
                        loading: "Deleting…",
                        success: "Document deleted",
                        error: "Couldn't delete document",
                      })
                    }
                  >
                    <TrashIcon /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
