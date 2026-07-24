"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, FileTextIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Citation } from "@/lib/types";

/** Every distinct reference survives, ordered by first appearance — a
 * previous version deduped by chunkId; refId (now on every Citation) is
 * the more direct key since it's also what inline markers resolve
 * against. */
function dedupeCitations(citations: Citation[]) {
  const seen = new Set<string>();
  const result: Citation[] = [];
  for (const citation of citations) {
    if (seen.has(citation.refId)) continue;
    seen.add(citation.refId);
    result.push(citation);
  }
  return result;
}

/** Hover-to-preview with a short close delay (so moving from badge to content doesn't
 *  close it), while still working as a plain click target on touch devices. */
function CitationPopoverContent({
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
  return (
    <>
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
    </>
  );
}

function useHoverPopover() {
  const [open, setOpen] = useState(false);
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  function openNow() {
    if (closeTimeout.current) clearTimeout(closeTimeout.current);
    setOpen(true);
  }

  function closeSoon() {
    closeTimeout.current = setTimeout(() => setOpen(false), 150);
  }

  return { open, setOpen, openNow, closeSoon };
}

/** A superscript-style numbered marker rendered inline in the streamed
 * prose, at the exact point the model cited this source — the counterpart
 * to the ordinal chip in the References panel below the message. Renders
 * nothing if the refId doesn't resolve yet (citations arrive in a single
 * batch after generation finishes — see marker-filter.ts's doc comment
 * for why — so an inline marker is briefly unresolved mid-stream and pops
 * in once the citations event lands). */
export function InlineCitation({
  refId,
  citations,
  fileNames,
  knowledgeBaseId,
}: {
  refId: string;
  citations: Citation[];
  fileNames?: Record<string, string>;
  knowledgeBaseId: string;
}) {
  const { open, setOpen, openNow, closeSoon } = useHoverPopover();
  const deduped = dedupeCitations(citations);
  const index = deduped.findIndex((c) => c.refId === refId);
  if (index === -1) return null;
  const citation = deduped[index]!;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        className="mx-0.5 inline-flex h-[1.1em] min-w-[1.1em] -translate-y-[0.35em] items-center justify-center rounded-xs border border-border/70 px-[3px] align-top text-[0.65em] leading-none font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
      >
        {index + 1}
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm" side="top" align="start" onMouseEnter={openNow} onMouseLeave={closeSoon}>
        <CitationPopoverContent
          index={index}
          citation={citation}
          fileName={fileNames?.[citation.documentId]}
          knowledgeBaseId={knowledgeBaseId}
        />
      </PopoverContent>
    </Popover>
  );
}

function ReferenceRow({
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
  const { open, setOpen, openNow, closeSoon } = useHoverPopover();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        className={cn(
          "flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent/60",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center rounded-xs border border-border/70 text-[10px] font-medium text-muted-foreground">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {fileName ?? `Source ${index + 1}`}
          {citation.pageNumber !== null && <span> · p.{citation.pageNumber}</span>}
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm" side="top" align="start" onMouseEnter={openNow} onMouseLeave={closeSoon}>
        <CitationPopoverContent index={index} citation={citation} fileName={fileName} knowledgeBaseId={knowledgeBaseId} />
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
    <div className="mt-3 border-t border-border/60 pt-2.5">
      <p className="mb-1 text-caption font-medium text-muted-foreground">References</p>
      <div>
        {deduped.map((citation, index) => (
          <ReferenceRow
            key={citation.refId}
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
