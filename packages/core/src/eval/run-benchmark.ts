import type { EmbeddingProvider, LLMProvider } from "@raas/providers";
import { FakeLLMProvider } from "@raas/providers";

import { assembleContext } from "../context/assemble-context.js";
import { validateCitations } from "../citations/validate-citations.js";
import { buildChatMessages } from "../prompt/build-messages.js";
import { IdentityReranker } from "../reranking/identity.js";
import type { Reranker } from "../reranking/types.js";
import { LexicalEmbeddingProvider, rankByCosineSimilarity } from "./lexical-embedding.js";
import { citationCoverage, mean, precisionAtK, recallAtK, reciprocalRank, unsupportedCitationRate } from "./metrics.js";
import type { EvalCase, EvalCaseResult, EvalDataset, EvalReport } from "./types.js";

const DEFAULT_K = 5;

export interface RunRetrievalBenchmarkOptions {
  /** Number of chunks retrieved per question, before reranking. Reranking
   * only ever reorders this set — it never grows it (matches
   * `apps/api/src/routes/chat.ts`'s real pipeline: rerank runs on the
   * candidates similarity search already returned). Default 5. */
  k?: number;
  /** Defaults to `LexicalEmbeddingProvider` (deterministic, offline, and
   * lexically meaningful — see its doc comment). Pass a real
   * `EmbeddingProvider` (e.g. `@raas/providers`'s `OpenAIEmbeddingProvider`)
   * for a "live" evaluation of the real embedding model — no other change
   * to this function or its caller is required, since both conform to the
   * same interface. */
  embeddingProvider?: EmbeddingProvider;
  /** Defaults to `IdentityReranker` — the shipped production default (see
   * `../reranking/identity.ts`). Pass any other `Reranker` implementation
   * (this package's `KeywordOverlapReranker`, or a real cross-encoder
   * adapter) to evaluate it; this is the whole point of the framework —
   * see `EVALUATION.md`. */
  reranker?: Reranker;
  /** Defaults to `FakeLLMProvider` (deterministic, offline — see its doc
   * comment in `@raas/providers`). A real `LLMProvider` can be substituted
   * for a live end-to-end run, at the cost of no longer being
   * deterministic or free. */
  llmProvider?: LLMProvider;
}

/**
 * Runs every question in `dataset` through the same four pipeline stages
 * `POST /kb/:id/chat` runs in production (`apps/api/src/routes/chat.ts`):
 * embed the query -> retrieve top-K by similarity -> rerank -> assemble
 * context -> generate -> validate citations — and scores the result
 * against the dataset's hand-labeled ground truth.
 *
 * The only stages actually substituted for this to run without a live
 * Postgres connection or a paid API call are retrieval's *storage* (an
 * in-memory `Map` + `rankByCosineSimilarity` instead of `searchSimilarChunks`
 * against pgvector — same ranking math, see that function's doc comment)
 * and, by default, the embedding/LLM providers themselves (deterministic
 * fakes, swappable — see the options above). `assembleContext`,
 * `buildChatMessages`, and `validateCitations` are the exact same
 * production functions, imported directly, not reimplemented or mocked.
 */
export async function runRetrievalBenchmark(dataset: EvalDataset, options: RunRetrievalBenchmarkOptions = {}): Promise<EvalReport> {
  const k = options.k ?? DEFAULT_K;
  const embeddingProvider = options.embeddingProvider ?? new LexicalEmbeddingProvider();
  const reranker = options.reranker ?? new IdentityReranker();
  const llmProvider = options.llmProvider ?? new FakeLLMProvider();

  // Chunks are embedded once, up front — mirrors ingestion embedding each
  // chunk exactly once at document-processing time, never per query.
  const chunkTexts = dataset.chunks.map((chunk) => chunk.content);
  const chunkVectors = chunkTexts.length > 0 ? await embeddingProvider.embed(chunkTexts) : [];
  const embeddings = new Map(dataset.chunks.map((chunk, i) => [chunk.id, chunkVectors[i]!]));

  const cases: EvalCaseResult[] = [];
  for (const evalCase of dataset.cases) {
    cases.push(await runCase(evalCase, { dataset, k, embeddingProvider, reranker, llmProvider, embeddings }));
  }

  return {
    datasetName: dataset.name,
    k,
    cases,
    aggregate: {
      meanRecallAtK: mean(cases.map((c) => c.recallAtK)),
      meanPrecisionAtK: mean(cases.map((c) => c.precisionAtK)),
      mrr: mean(cases.map((c) => c.reciprocalRank)),
      meanCitationCoverage: mean(cases.map((c) => c.citationCoverage)),
      meanUnsupportedCitationRate: mean(cases.map((c) => c.unsupportedCitationRate)),
    },
  };
}

async function runCase(
  evalCase: EvalCase,
  ctx: {
    dataset: EvalDataset;
    k: number;
    embeddingProvider: EmbeddingProvider;
    reranker: Reranker;
    llmProvider: LLMProvider;
    embeddings: Map<string, number[]>;
  },
): Promise<EvalCaseResult> {
  const [queryVector] = await ctx.embeddingProvider.embed([evalCase.question]);

  const candidates = rankByCosineSimilarity(ctx.dataset.chunks, ctx.embeddings, queryVector!, ctx.k);
  const reranked = await ctx.reranker.rerank({ query: evalCase.question, chunks: candidates });
  const retrievedChunkIds = reranked.map((chunk) => chunk.chunkId);

  const assembled = assembleContext(reranked);
  const messages = buildChatMessages(assembled.contextText, evalCase.question);

  let rawText = "";
  for await (const delta of ctx.llmProvider.streamCompletion(messages)) {
    rawText += delta;
  }

  const citations = validateCitations(rawText, assembled.chunks);
  const citedChunkIds = citations.map((citation) => citation.chunkId);

  return {
    caseId: evalCase.id,
    question: evalCase.question,
    retrievedChunkIds,
    citedChunkIds,
    recallAtK: recallAtK(retrievedChunkIds, evalCase.expectedRelevantChunkIds),
    precisionAtK: precisionAtK(retrievedChunkIds, evalCase.expectedRelevantChunkIds),
    reciprocalRank: reciprocalRank(retrievedChunkIds, evalCase.expectedRelevantChunkIds),
    citationCoverage: citationCoverage(citedChunkIds, evalCase.expectedCitationChunkIds),
    unsupportedCitationRate: unsupportedCitationRate(citedChunkIds, evalCase.expectedCitationChunkIds),
  };
}
