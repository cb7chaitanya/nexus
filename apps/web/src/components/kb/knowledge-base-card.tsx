import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { DatabaseIcon, FileTextIcon, Loader2Icon, MessageCircleIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useKnowledgeBase } from "@/hooks/use-knowledge-bases";
import { useSession } from "@/lib/session-context";
import type { KnowledgeBase } from "@/lib/types";

export function KnowledgeBaseCard({ kb }: { kb: KnowledgeBase }) {
  const { currentOrganization } = useSession();
  const detail = useKnowledgeBase(kb.id, currentOrganization.id);
  const stats = detail.data?.stats;

  return (
    <Card interactive className="group py-5">
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
            <DatabaseIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">
              <Link href={`/kb/${kb.id}`} className="hover:underline">
                {kb.name}
              </Link>
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Updated {formatDistanceToNow(new Date(kb.updatedAt), { addSuffix: true })}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {kb.description && (
          <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">{kb.description}</p>
        )}
        <div className="mb-4 flex items-center gap-3 text-xs text-muted-foreground">
          {stats ? (
            <span className="flex items-center gap-1">
              <FileTextIcon className="size-3.5" />
              {stats.documentCount} {stats.documentCount === 1 ? "document" : "documents"}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <Loader2Icon className="size-3.5 animate-spin" /> Loading…
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" asChild className="flex-1">
            <Link href={`/kb/${kb.id}`}>Manage</Link>
          </Button>
          <Button size="sm" asChild className="flex-1">
            <Link href={`/kb/${kb.id}/chat`}>
              <MessageCircleIcon /> Chat
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
