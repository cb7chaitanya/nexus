"use client";

import { use, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  FileTextIcon,
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
import { DocumentActivityTimeline } from "@/components/kb/document-activity-timeline";
import { RenameKnowledgeBaseDialog } from "@/components/kb/rename-knowledge-base-dialog";
import { DeleteKnowledgeBaseDialog } from "@/components/kb/delete-knowledge-base-dialog";
import { StatCard } from "@/components/dashboard/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
                <Button variant="outline" size="icon" aria-label="Knowledge base actions">
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
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border sm:flex-row sm:divide-x sm:divide-y-0">
          <StatCard label="Documents" value={String(kb.data.stats.documentCount)} />
          <StatCard label="Chunks indexed" value={String(kb.data.stats.chunkCount)} />
          <StatCard label="Storage used" value={formatBytes(kb.data.stats.storageBytes)} />
        </div>

        <section>
          <h2 className="mb-3 text-h4">Upload documents</h2>
          <UploadDropzone knowledgeBaseId={id} organizationId={currentOrganization.id} />
        </section>

        <div className="grid gap-8 lg:grid-cols-3">
          <section className="lg:col-span-2">
            <h2 className="mb-3 text-h4">Documents</h2>
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

          {!documents.isLoading && docs.length > 0 && (
            <section>
              <h2 className="mb-3 text-h4">Recent activity</h2>
              <Card className="py-4">
                <CardContent>
                  <DocumentActivityTimeline documents={docs} />
                </CardContent>
              </Card>
            </section>
          )}
        </div>
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
