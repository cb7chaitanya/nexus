"use client";

import { FileTextIcon } from "lucide-react";

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

export function CitationList({
  citations,
  fileNames,
}: {
  citations: Citation[];
  fileNames?: Record<string, string>;
}) {
  if (citations.length === 0) return null;
  const deduped = dedupeCitations(citations);

  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {deduped.map((citation, index) => {
        const fileName = fileNames?.[citation.documentId];
        return (
          <Popover key={citation.chunkId}>
            <PopoverTrigger className="inline-flex max-w-48 items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
              <FileTextIcon className="size-3 shrink-0" />
              <span className="truncate">{fileName ?? `Source ${index + 1}`}</span>
              {citation.pageNumber !== null && <span className="shrink-0">· p.{citation.pageNumber}</span>}
            </PopoverTrigger>
            <PopoverContent className="w-80 text-sm" side="top">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <FileTextIcon className="size-3.5 shrink-0" />
                <span className="truncate">{fileName ?? `Source ${index + 1}`}</span>
                {citation.pageNumber !== null && <span className="shrink-0">· Page {citation.pageNumber}</span>}
              </div>
              <p className="text-sm text-foreground/90">&ldquo;{citation.quote}&rdquo;</p>
            </PopoverContent>
          </Popover>
        );
      })}
    </div>
  );
}
