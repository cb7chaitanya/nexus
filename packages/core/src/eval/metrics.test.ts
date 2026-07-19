import { describe, expect, it } from "vitest";

import { citationCoverage, mean, precisionAtK, recallAtK, reciprocalRank, unsupportedCitationRate } from "./metrics.js";

describe("recallAtK", () => {
  it("is 1.0 when every expected chunk was retrieved", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "b"])).toBe(1);
  });

  it("is the fraction of expected chunks actually retrieved", () => {
    expect(recallAtK(["a", "x", "y"], ["a", "b"])).toBe(0.5);
  });

  it("is 0 when none of the expected chunks were retrieved", () => {
    expect(recallAtK(["x", "y"], ["a", "b"])).toBe(0);
  });

  it("is vacuously 1.0 when nothing was expected", () => {
    expect(recallAtK(["x"], [])).toBe(1);
    expect(recallAtK([], [])).toBe(1);
  });
});

describe("precisionAtK", () => {
  it("is 1.0 when every retrieved chunk was expected", () => {
    expect(precisionAtK(["a", "b"], ["a", "b", "c"])).toBe(1);
  });

  it("is the fraction of retrieved chunks that were actually expected", () => {
    expect(precisionAtK(["a", "x"], ["a"])).toBe(0.5);
  });

  it("divides by what was actually retrieved, not a fixed K", () => {
    // Only 1 chunk retrieved (e.g. a knowledge base with fewer chunks than
    // K) — precision is out of 1, not out of some larger assumed K.
    expect(precisionAtK(["a"], ["a", "b"])).toBe(1);
  });

  it("is 0 when nothing retrieved was expected", () => {
    expect(precisionAtK(["x", "y"], ["a"])).toBe(0);
  });

  it("is 1.0 (vacuous) when nothing was retrieved and nothing was expected", () => {
    expect(precisionAtK([], [])).toBe(1);
  });

  it("is 0 when nothing was retrieved but something was expected", () => {
    expect(precisionAtK([], ["a"])).toBe(0);
  });
});

describe("reciprocalRank", () => {
  it("is 1.0 when the first retrieved result is relevant", () => {
    expect(reciprocalRank(["a", "x"], ["a"])).toBe(1);
  });

  it("is 1/rank of the first relevant result", () => {
    expect(reciprocalRank(["x", "y", "a"], ["a"])).toBeCloseTo(1 / 3);
  });

  it("is 0 when no retrieved result is relevant", () => {
    expect(reciprocalRank(["x", "y"], ["a"])).toBe(0);
  });

  it("only counts the EARLIEST relevant result, not any later one", () => {
    expect(reciprocalRank(["x", "a", "b"], ["a", "b"])).toBe(0.5);
  });

  it("is 0 when nothing was expected (no rank of a nonexistent target)", () => {
    expect(reciprocalRank(["a", "b"], [])).toBe(0);
  });
});

describe("citationCoverage", () => {
  it("is 1.0 when every expected citation was produced", () => {
    expect(citationCoverage(["a", "b", "c"], ["a", "b"])).toBe(1);
  });

  it("is the fraction of expected citations actually produced", () => {
    expect(citationCoverage(["a"], ["a", "b"])).toBe(0.5);
  });

  it("is 0 when nothing expected was cited", () => {
    expect(citationCoverage(["x"], ["a"])).toBe(0);
  });

  it("is vacuously 1.0 when nothing was expected to be cited", () => {
    expect(citationCoverage([], [])).toBe(1);
    expect(citationCoverage(["x"], [])).toBe(1);
  });
});

describe("unsupportedCitationRate", () => {
  it("is 0 when every citation produced was expected", () => {
    expect(unsupportedCitationRate(["a"], ["a", "b"])).toBe(0);
  });

  it("is the fraction of produced citations that were NOT expected for this question", () => {
    expect(unsupportedCitationRate(["a", "x"], ["a"])).toBe(0.5);
  });

  it("is 1.0 when nothing produced was expected — citing real-but-wrong material", () => {
    expect(unsupportedCitationRate(["x", "y"], ["a"])).toBe(1);
  });

  it("is 0 when nothing was cited at all — no citations means nothing unsupported", () => {
    expect(unsupportedCitationRate([], ["a"])).toBe(0);
  });
});

describe("mean", () => {
  it("averages a list of numbers", () => {
    expect(mean([1, 2, 3])).toBe(2);
  });

  it("is 0 for an empty list rather than NaN", () => {
    expect(mean([])).toBe(0);
  });
});
