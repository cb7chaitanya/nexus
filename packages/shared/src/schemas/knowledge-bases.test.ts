import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PLATFORM_EMBEDDING_DIM } from "../constants.js";
import { createKnowledgeBaseSchema } from "./knowledge-bases.js";

const base = {
  organizationId: randomUUID(),
  name: "Support Docs",
  embeddingProvider: "openai",
  embeddingModel: "text-embedding-3-small",
};

describe("createKnowledgeBaseSchema", () => {
  it("accepts the platform's fixed embedding dimension", () => {
    const result = createKnowledgeBaseSchema.safeParse({ ...base, embeddingDim: PLATFORM_EMBEDDING_DIM });
    expect(result.success).toBe(true);
  });

  it("rejects any other embedding dimension", () => {
    const result = createKnowledgeBaseSchema.safeParse({ ...base, embeddingDim: 768 });
    expect(result.success).toBe(false);
  });
});
