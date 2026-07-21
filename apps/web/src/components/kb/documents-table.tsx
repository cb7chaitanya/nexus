"use client";

import { formatDistanceToNow } from "date-fns";
import { MoreHorizontalIcon, RotateCwIcon, TrashIcon } from "lucide-react";
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
import { DocumentStatusBadge } from "@/components/kb/document-status-badge";
import { useDeleteDocument, useRetryDocument } from "@/hooks/use-documents";
import type { Document } from "@/lib/types";

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

  return (
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
        {documents.map((document) => (
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
  );
}
