const MARKER_PREFIX = "[[";
const MARKER_SUFFIX = "]]";
// Generous upper bound on "[[chunk:<refId>]]" — assembleContext assigns
// short refIds ("c1", "c2", ...), so anything held this long without
// closing was never a real marker, just a literal "[[" in the model's
// prose (e.g. markdown-style double brackets).
const MAX_HOLD_CHARS = 64;
const FULL_MARKER_RE = /^\[\[chunk:([^[\]]+)]]$/;

/**
 * Streaming filter that rewrites `[[chunk:refId]]` citation markers out of
 * an LLM's token-by-token output before any text is forwarded to the
 * client. The model is instructed to emit these markers (see
 * prompt/build-messages.ts) as an internal signal for server-side
 * citation parsing — the raw `chunk:` form must never be rendered to a
 * user (docs/implementation-plan.md §2 item 5): a raw marker streamed
 * inline would show the user something that a later validation pass might
 * then silently retract, which is exactly the bug this filter exists to
 * avoid.
 *
 * A marker whose refId is in the constructor's `validRefIds` — i.e. it
 * points at a chunk that was genuinely part of this request's retrieved
 * context — is rewritten to a client-safe `[[cite:refId]]` token instead
 * of being dropped, so the frontend can render an inline citation exactly
 * where the model placed it. A marker whose refId doesn't resolve (the
 * model citing something never in its context) is dropped entirely, same
 * as before — this preserves the "never show an unverified citation"
 * guarantee, just enforced per-marker as it streams rather than only at
 * the end. The end-of-stream `citations` event (validateCitations) is
 * still what carries the full {chunkId, documentId, pageNumber, quote}
 * payload per refId — the inline token only carries the key to look it up.
 *
 * Text is only ever released once it's unambiguous: a run of characters
 * that can't be the start of a marker is emitted immediately; a run that
 * starts with "[[" is held back until it either completes into a full
 * marker (rewritten or dropped, never emitted as `chunk:`) or is
 * confirmed not to be one (emitted as-is, brackets and all).
 *
 * Simplification worth naming: this does not handle a marker containing a
 * nested "[[" before its closing "]]" (real output from the system prompt
 * in prompt/build-messages.ts never does this — refIds are always the
 * plain "cN" tokens assembleContext assigns).
 */
export class CitationMarkerFilter {
  private raw = "";
  private pending = "";
  private readonly validRefIds: ReadonlySet<string>;

  /** `validRefIds` should be the refIds of this request's own assembled
   * context chunks — omitting it (or passing an empty set) makes every
   * marker unresolved, i.e. stripped entirely, the original behavior. */
  constructor(validRefIds: ReadonlySet<string> = new Set()) {
    this.validRefIds = validRefIds;
  }

  /** Feed the next raw text delta from the LLM stream; returns the text
   * (if any) that is now safe to send to the client. */
  push(delta: string): string {
    this.raw += delta;
    this.pending += delta;

    let output = "";
    for (;;) {
      const start = this.pending.indexOf(MARKER_PREFIX);
      if (start === -1) {
        output += this.pending;
        this.pending = "";
        break;
      }

      output += this.pending.slice(0, start);
      const rest = this.pending.slice(start);
      const end = rest.indexOf(MARKER_SUFFIX);

      if (end === -1) {
        if (rest.length > MAX_HOLD_CHARS) {
          output += rest;
          this.pending = "";
        } else {
          this.pending = rest;
        }
        break;
      }

      const candidate = rest.slice(0, end + MARKER_SUFFIX.length);
      const match = FULL_MARKER_RE.exec(candidate);
      if (!match) {
        output += candidate;
      } else if (this.validRefIds.has(match[1]!)) {
        output += `[[cite:${match[1]}]]`;
      }
      this.pending = rest.slice(candidate.length);
    }

    return output;
  }

  /** Call once the stream ends: returns any remaining buffered text that
   * turned out not to be (the start of) a marker. Must be called, or a
   * trailing non-marker fragment held back by push() is silently lost. */
  flush(): string {
    const output = this.pending;
    this.pending = "";
    return output;
  }

  /** The complete, unfiltered raw text seen so far — including markers —
   * for validateCitations to parse after generation completes. */
  get fullText(): string {
    return this.raw;
  }
}
