"use client";

import { FileTextIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Citation } from "@/lib/types";

function groupByDocument(citations: Citation[]) {
  const seen = new Map<string, Citation>();
  for (const citation of citations) {
    if (!seen.has(citation.documentId)) seen.set(citation.documentId, citation);
  }
  return Array.from(seen.values());
}

export function CitationList({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;
  const grouped = groupByDocument(citations);

  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {grouped.map((citation, index) => (
        <Popover key={citation.chunkId}>
          <PopoverTrigger className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
            <FileTextIcon className="size-3" />
            Source {index + 1}
            {citation.pageNumber !== null && <span>· p.{citation.pageNumber}</span>}
          </PopoverTrigger>
          <PopoverContent className="w-80 text-sm" side="top">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <FileTextIcon className="size-3.5" />
              Source {index + 1}
              {citation.pageNumber !== null && <span>· Page {citation.pageNumber}</span>}
            </div>
            <p className="text-sm text-foreground/90">&ldquo;{citation.quote}&rdquo;</p>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  );
}
