"use client";

import { use, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  FileTextIcon,
  HardDriveIcon,
  LayersIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SearchXIcon,
  TrashIcon,
} from "lucide-react";

import { useSession } from "@/lib/session-context";
import { useKnowledgeBase } from "@/hooks/use-knowledge-bases";
import { useDocuments } from "@/hooks/use-documents";
import { PageHeader } from "@/components/layout/page-header";
import { UploadDropzone } from "@/components/kb/upload-dropzone";
import { DocumentsTable } from "@/components/kb/documents-table";
import { RenameKnowledgeBaseDialog } from "@/components/kb/rename-knowledge-base-dialog";
import { DeleteKnowledgeBaseDialog } from "@/components/kb/delete-knowledge-base-dialog";
import { StatCard } from "@/components/dashboard/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

export default function KnowledgeBaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { currentOrganization } = useSession();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const kb = useKnowledgeBase(id, currentOrganization.id);
  const documents = useDocuments(id, currentOrganization.id);
  const docs = documents.data?.data ?? [];

  if (kb.isLoading) {
    return (
      <div className="px-6 py-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-4 h-32 w-full rounded-xl" />
      </div>
    );
  }

  if (!kb.data) {
    return (
      <div className="px-6 py-16">
        <EmptyState
          icon={SearchXIcon}
          title="Knowledge base not found"
          description="It may have been deleted, or you may not have access to it."
          action={
            <Button variant="outline" asChild>
              <Link href="/kb">
                <ArrowLeftIcon /> Back to knowledge bases
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="pb-16">
      <PageHeader
        title={kb.data.name}
        description={kb.data.description ?? undefined}
        action={
          <div className="flex items-center gap-2">
            <Button asChild>
              <Link href={`/kb/${id}/chat`}>
                <MessageCircleIcon /> Chat
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                  <PencilIcon /> Edit details
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                  <TrashIcon /> Delete knowledge base
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <div className="space-y-8 px-6 py-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Documents" icon={FileTextIcon} value={String(kb.data.stats.documentCount)} />
          <StatCard label="Chunks indexed" icon={LayersIcon} value={String(kb.data.stats.chunkCount)} />
          <StatCard label="Storage used" icon={HardDriveIcon} value={formatBytes(kb.data.stats.storageBytes)} />
        </div>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Upload documents</h2>
          <UploadDropzone knowledgeBaseId={id} organizationId={currentOrganization.id} />
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Documents</h2>
          {documents.isLoading ? (
            <Skeleton className="h-48 w-full rounded-xl" />
          ) : docs.length === 0 ? (
            <EmptyState
              icon={FileTextIcon}
              title="No documents yet"
              description="Upload PDFs or text files above to start building this knowledge base."
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              <DocumentsTable documents={docs} knowledgeBaseId={id} organizationId={currentOrganization.id} />
            </div>
          )}
        </section>
      </div>

      <RenameKnowledgeBaseDialog
        knowledgeBaseId={id}
        organizationId={currentOrganization.id}
        defaultValues={{ name: kb.data.name, description: kb.data.description }}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <DeleteKnowledgeBaseDialog
        knowledgeBaseId={id}
        knowledgeBaseName={kb.data.name}
        organizationId={currentOrganization.id}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </div>
  );
}
