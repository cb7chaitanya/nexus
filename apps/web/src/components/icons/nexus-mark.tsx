/**
 * The Nexus brand mark — a "convergence" glyph: two source nodes resolving
 * into one larger answer node, mirroring the product's own retrieval →
 * generation model. Kept sparse (three filled dots, two strokes) so it
 * still reads cleanly at 16×16 — no separate simplified favicon variant
 * needed, this same geometry is reused for icon.tsx/apple-icon.tsx/
 * opengraph-image.tsx.
 */
export function NexusMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <line x1="5" y1="6" x2="18.5" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="5" y1="18" x2="18.5" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="5" cy="6" r="2.25" fill="currentColor" />
      <circle cx="5" cy="18" r="2.25" fill="currentColor" />
      <circle cx="19" cy="12" r="3.25" fill="currentColor" />
    </svg>
  );
}
