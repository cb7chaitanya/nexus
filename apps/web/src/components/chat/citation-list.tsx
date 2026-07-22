"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, FileTextIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Citation } from "@/lib/types";

/** Every distinct quote survives — a previous version kept only the first chunk seen per document, silently dropping other relevant passages from the same file. */
function dedupeCitations(citations: Citation[]) {
  const seen = new Set<string>();
  const result: Citation[] = [];
  for (const citation of citations) {
    if (seen.has(citation.chunkId)) continue;
    seen.add(citation.chunkId);
    result.push(citation);
  }
  return result;
}

/** Hover-to-preview with a short close delay (so moving from badge to content doesn't
 *  close it), while still working as a plain click target on touch devices. */
function CitationBadge({
  index,
  citation,
  fileName,
  knowledgeBaseId,
}: {
  index: number;
  citation: Citation;
  fileName?: string;
  knowledgeBaseId: string;
}) {
  const [open, setOpen] = useState(false);
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  function openNow() {
    if (closeTimeout.current) clearTimeout(closeTimeout.current);
    setOpen(true);
  }

  function closeSoon() {
    closeTimeout.current = setTimeout(() => setOpen(false), 150);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
      >
        {index + 1}
      </PopoverTrigger>
      <PopoverContent
        className="w-80 text-sm"
        side="top"
        align="start"
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
      >
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <FileTextIcon className="size-3.5 shrink-0" />
          <span className="truncate">{fileName ?? `Source ${index + 1}`}</span>
          {citation.pageNumber !== null && <span className="shrink-0">· Page {citation.pageNumber}</span>}
        </div>
        <p className="text-sm text-foreground/90">&ldquo;{citation.quote}&rdquo;</p>
        <Link
          href={`/kb/${knowledgeBaseId}`}
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
        >
          Open knowledge base <ArrowRightIcon className="size-3" />
        </Link>
      </PopoverContent>
    </Popover>
  );
}

export function CitationList({
  citations,
  fileNames,
  knowledgeBaseId,
}: {
  citations: Citation[];
  fileNames?: Record<string, string>;
  knowledgeBaseId: string;
}) {
  if (citations.length === 0) return null;
  const deduped = dedupeCitations(citations);

  return (
    <div className="mt-3">
      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        Sources ({deduped.length})
      </p>
      <div className="flex flex-wrap gap-1.5">
        {deduped.map((citation, index) => (
          <CitationBadge
            key={citation.chunkId}
            index={index}
            citation={citation}
            fileName={fileNames?.[citation.documentId]}
            knowledgeBaseId={knowledgeBaseId}
          />
        ))}
      </div>
    </div>
  );
}
