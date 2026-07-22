import { describe, expect, it } from "vitest";

import { CitationMarkerFilter } from "./marker-filter.js";

describe("CitationMarkerFilter", () => {
  it("passes through text with no markers unchanged", () => {
    const filter = new CitationMarkerFilter();
    expect(filter.push("Hello, world!")).toBe("Hello, world!");
    expect(filter.flush()).toBe("");
  });

  it("strips a marker fully contained in a single push", () => {
    const filter = new CitationMarkerFilter();
    const out = filter.push("The sky is blue. [[chunk:c1]] Trust me.");
    expect(out).toBe("The sky is blue.  Trust me.");
    expect(out).not.toContain("[[chunk:");
  });

  it("strips a marker split across multiple pushes", () => {
    const filter = new CitationMarkerFilter();
    let out = filter.push("Hello [[chu");
    expect(out).toBe("Hello ");
    expect(out).not.toContain("[[");

    out = filter.push("nk:c1]] world");
    expect(out).toBe(" world");
    expect(filter.flush()).toBe("");
  });

  it("strips a marker split right at the closing ]]", () => {
    const filter = new CitationMarkerFilter();
    let out = filter.push("see [[chunk:c1]");
    expect(out).toBe("see ");

    out = filter.push("] now");
    expect(out).toBe(" now");
  });

  it("strips multiple markers appearing in one push", () => {
    const filter = new CitationMarkerFilter();
    const out = filter.push("A [[chunk:c1]] and B [[chunk:c2]] both matter.");
    expect(out).toBe("A  and B  both matter.");
  });

  it("does not strip literal double brackets that never form a chunk marker", () => {
    const filter = new CitationMarkerFilter();
    const out = filter.push("See [[note]] for details.");
    expect(out).toBe("See [[note]] for details.");
  });

  it("flushes held-back text that never completed into a marker", () => {
    const filter = new CitationMarkerFilter();
    const out = filter.push("trailing [[chu");
    expect(out).toBe("trailing ");
    expect(filter.flush()).toBe("[[chu");
  });

  it("gives up holding an unbounded '[[' that never closes and flushes it as literal text", () => {
    const filter = new CitationMarkerFilter();
    const longRun = "[[" + "x".repeat(100);
    const out = filter.push(`before ${longRun} after`);
    // Exceeds the hold budget mid-push, so the whole run (including
    // " after") is flushed immediately rather than waiting for flush().
    expect(out).toBe(`before ${longRun} after`);
  });

  it("exposes the complete raw text including markers via fullText", () => {
    const filter = new CitationMarkerFilter();
    filter.push("A [[chunk:c1]] claim.");
    expect(filter.fullText).toBe("A [[chunk:c1]] claim.");
  });

  it("never emits a raw marker across the combination of all push() outputs plus flush()", () => {
    const filter = new CitationMarkerFilter();
    const chunks = ["Intro ", "[[chu", "nk:c1", "]] mid ", "[[chunk:c2]]", " end"];
    let assembled = "";
    for (const chunk of chunks) assembled += filter.push(chunk);
    assembled += filter.flush();

    expect(assembled).not.toContain("[[chunk:");
    expect(assembled).toBe("Intro  mid  end");
  });

  it("rewrites a marker resolving to a valid refId into a client-safe cite token", () => {
    const filter = new CitationMarkerFilter(new Set(["c1"]));
    const out = filter.push("The sky is blue. [[chunk:c1]] Trust me.");
    expect(out).toBe("The sky is blue. [[cite:c1]] Trust me.");
    expect(out).not.toContain("[[chunk:");
  });

  it("still drops a marker whose refId is not in validRefIds", () => {
    const filter = new CitationMarkerFilter(new Set(["c1"]));
    const out = filter.push("A claim. [[chunk:c99]] Another.");
    expect(out).toBe("A claim.  Another.");
    expect(out).not.toContain("[[cite:");
    expect(out).not.toContain("[[chunk:");
  });

  it("rewrites a valid marker split across multiple pushes", () => {
    const filter = new CitationMarkerFilter(new Set(["c1"]));
    let out = filter.push("see [[chu");
    expect(out).toBe("see ");
    out = filter.push("nk:c1]] now");
    expect(out).toBe("[[cite:c1]] now");
  });

  it("rewrites multiple resolved markers, each looked up independently", () => {
    const filter = new CitationMarkerFilter(new Set(["c1", "c2"]));
    const out = filter.push("A [[chunk:c1]] and B [[chunk:c2]] and C [[chunk:c3]].");
    expect(out).toBe("A [[cite:c1]] and B [[cite:c2]] and C .");
  });
});
