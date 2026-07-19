# Retrieval evaluation framework

`packages/core/src/eval/` measures retrieval and citation quality against
a hand-labeled benchmark dataset. It is a development-time tool, not
production code: nothing under `src/eval/` is exported from
`@raas/core`'s package index (`src/index.ts`), so `apps/api` and
`apps/worker` — which only ever import from `@raas/core` itself — never
load any of it. It adds no new npm dependency; every provider/reranker it
uses either already exists in this package or in `@raas/providers`.

Every test in this framework runs fully offline: no live Postgres
connection, no embedding/LLM API call, no network access, same result
every run. That's a design constraint, not an accident — see
[Why fully offline](#why-fully-offline) below.

## Running it

```bash
pnpm --filter @raas/core run eval:retrieval                          # default: identity reranker, K=5
pnpm --filter @raas/core run eval:retrieval -- --reranker=keyword     # a non-identity reranker
pnpm --filter @raas/core run eval:retrieval -- --k=3
```

Prints per-question Recall@K/Precision@K/reciprocal-rank/citation
coverage/unsupported-citation-rate, plus dataset-level aggregates.

The automated test suite (`pnpm --filter @raas/core test`) also exercises
this framework directly — `src/eval/*.test.ts` — as a regression guard on
the metrics themselves and on the sample dataset's expected scores.

## Dataset format

A dataset (`EvalDataset`, `src/eval/types.ts`) is plain data: the chunks
that would otherwise be `DocumentChunk` rows, plus a set of questions with
hand-labeled ground truth.

```ts
interface EvalChunk {
  id: string; // fixture-local id, not a real UUID
  documentId: string;
  chunkIndex: number;
  content: string;
  pageNumber: number | null;
}

interface EvalCase {
  id: string;
  question: string;
  expectedRelevantChunkIds: string[]; // ground truth for Recall@K/Precision@K/MRR
  expectedCitationChunkIds: string[]; // ground truth for citation coverage/unsupported rate
}

interface EvalDataset {
  name: string;
  chunks: EvalChunk[];
  cases: EvalCase[];
}
```

`expectedCitationChunkIds` is usually a narrower set than
`expectedRelevantChunkIds`: a chunk can be relevant enough to retrieve as
supporting context without being the specific chunk a precise answer
should cite. See `src/eval/fixtures/sample-dataset.ts` for a worked
example (four topics, eight chunks, four questions) and its doc comment
for why the topics deliberately use disjoint vocabulary.

To add a dataset: write a new file under `src/eval/fixtures/` exporting an
`EvalDataset`, and pass it to `runRetrievalBenchmark` (from a test, or
from a copy of `scripts/benchmark-retrieval.ts` pointed at the new
dataset).

## Metrics (`src/eval/metrics.ts`)

All are pure functions over arrays of chunk ids — no I/O, in `[0, 1]`.

**Retrieval:**

- **Recall@K** — of everything that *should* have been retrieved, what
  fraction actually was, within the top K results.
- **Precision@K** — of what *was* retrieved, what fraction was actually
  relevant. Divides by what was actually returned, not a fixed K, so a
  knowledge base with fewer than K chunks isn't unfairly penalized.
- **MRR** (Mean Reciprocal Rank) — the mean, across all questions, of
  `1 / rank` of the first relevant result (0 if none of the top K were
  relevant). Rewards ranking the right answer *first*, not just somewhere
  in the top K — the metric Recall/Precision@K can't capture on their own.

**Generation:**

- **Citation coverage** — of everything a correct answer should have
  cited (`expectedCitationChunkIds`), what fraction actually got cited.
  Low coverage means under-citing.
- **Unsupported citation rate** — of everything that *was* cited, what
  fraction wasn't actually one of the expected sources for that specific
  question. This is deliberately **not** the same thing
  `validateCitations` (`src/citations/validate-citations.ts`) already
  checks. `validateCitations` only verifies a citation marker resolves to
  a chunk that was genuinely present in the context sent for that request
  — structural validity. Every citation this framework scores has already
  passed that check by construction (it's produced by calling
  `validateCitations` for real — see below). A citation counted
  "unsupported" here is structurally valid — it points at real, in-context
  material — but is the *wrong* source for this question per the
  fixture's ground truth: citing something real but irrelevant, not
  fabricating a source. Structural hallucination and topical wrongness are
  different failure modes with different fixes (prompt/parsing vs.
  retrieval/rerank quality), which is why they're scored separately.

Edge cases (documented in `metrics.ts`'s own comments): an empty
`expected` set scores as a vacuous 1.0 for recall/precision/coverage, and
0 for MRR. Real fixtures shouldn't hit this — every question should have
at least one expected relevant chunk — but the functions stay total
rather than throwing on a malformed fixture.

## How a benchmark run works (`src/eval/run-benchmark.ts`)

`runRetrievalBenchmark(dataset, options)` runs every question through the
same four pipeline stages `POST /kb/:id/chat` runs in production
(`apps/api/src/routes/chat.ts`): embed the query → retrieve top-K by
similarity → rerank → assemble context → generate → validate citations.

`assembleContext`, `buildChatMessages`, and `validateCitations` are the
**exact same production functions** from this package, imported directly
— not reimplemented, not mocked. The two things substituted, both via
dependency injection through `runRetrievalBenchmark`'s options, are:

| Production | This framework's default | Why |
|---|---|---|
| `searchSimilarChunks` (pgvector query, needs live Postgres) | `rankByCosineSimilarity` (in-memory, `src/eval/lexical-embedding.ts`) | Same ranking math (`score = cosine similarity`, best-first, capped at K) — ranking by cosine similarity is a property of the vectors, not of the database engine evaluating `<=>`. Skips the I/O, not the algorithm. |
| A real `EmbeddingProvider` (OpenAI, needs an API key) | `LexicalEmbeddingProvider` (deterministic, offline) | See [Why fully offline](#why-fully-offline). |
| A real `LLMProvider` (OpenAI, needs an API key) | `FakeLLMProvider` (`@raas/providers`, deterministic, offline) | Same fake already used by `apps/api/src/routes/chat.test.ts` and available in production as `LLM_PROVIDER=fake` — not a mock invented for this framework. |
| `apps/api/src/lib/reranker.ts`'s `getReranker()` | `IdentityReranker` (`@raas/core`'s actual shipped default) | The real production default — this framework doesn't invent a different baseline. |

All four are swappable via `RunRetrievalBenchmarkOptions` — passing a
different instance is the entire mechanism this framework uses to
evaluate anything new. See the next section.

## How future reranking models are evaluated

This is the framework's core purpose, so it's worth stating precisely.
`Reranker` (`src/reranking/types.ts`) is a one-method interface:

```ts
interface Reranker {
  rerank(params: { query: string; chunks: RetrievedChunk[] }): Promise<RetrievedChunk[]>;
}
```

`IdentityReranker` is the only production implementation today
(architecture.md §4.7: reranking is a real latency/cost tradeoff, off
until there's a measured quality reason to pay it — this framework is how
that measurement gets made). To evaluate a candidate reranker — a
cross-encoder, a hosted rerank API, anything:

1. Implement `Reranker`. If it calls a real API, wrap it exactly the way
   `SentryAdapter` wraps a real error tracker in `packages/observability`
   or the way `OpenAIEmbeddingProvider` wraps the OpenAI SDK in
   `@raas/providers` — structurally typed against the interface, no
   changes to anything that calls `.rerank(...)`.
2. Run it through `runRetrievalBenchmark(dataset, { reranker: new YourReranker() })`.
   No other argument needs to change, and neither does
   `runRetrievalBenchmark` itself, `assembleContext`, `validateCitations`,
   or `apps/api/src/routes/chat.ts` — the whole point of `Reranker` being
   a real interface rather than a hardcoded call is that swapping the
   implementation is the entire change.
3. Compare the resulting `EvalReport.aggregate` (and, more usefully, the
   per-case results — an aggregate improving can hide individual
   questions getting worse) against the same dataset run with
   `IdentityReranker`. `src/eval/reranker-swap.test.ts` is a worked,
   deterministic example of exactly this comparison: a fixture where
   `IdentityReranker` leaves a low-information decoy chunk ranked above
   the real answer, and a second `Reranker` implementation
   (`KeywordOverlapReranker` — a deterministic, offline stand-in for "a
   real reranker provider," not a production choice) provably corrects
   it, with the only difference between the two test runs being which
   `Reranker` instance was passed in.
4. Once a candidate reranker is worth adopting in production, the actual
   deploy step is a one-line change: `apps/api/src/lib/reranker.ts`'s
   `getReranker()` constructs the new implementation instead of
   `IdentityReranker`. Nothing else in the request path changes, because
   nothing else in the request path was ever written against
   `IdentityReranker` specifically — it was always written against
   `Reranker`.

Evaluating a new *embedding model* follows the identical mechanism, one
level earlier in the pipeline: implement `EmbeddingProvider`
(`@raas/providers`), pass it as `runRetrievalBenchmark`'s
`embeddingProvider` option. `apps/api/src/lib/embedding-provider.ts`'s
factory is the equivalent one-line production adoption point.

For a fully "live" evaluation against the real embedding/LLM providers
(spending real API cost, no longer deterministic) — pass real
`OpenAIEmbeddingProvider`/`OpenAIChatProvider` instances from
`@raas/providers` as `embeddingProvider`/`llmProvider`. Nothing about
`runRetrievalBenchmark`'s signature changes for that either; it's the same
options object.

## Why fully offline

Two separate fakes are involved, and they solve different problems —
worth being explicit about which is which:

- **`FakeLLMProvider`** (`@raas/providers`) is the same fake production
  code already uses for `LLM_PROVIDER=fake`. Reused as-is, not
  reimplemented.
- **`LexicalEmbeddingProvider`** (`src/eval/lexical-embedding.ts`) is
  new, and is *not* `@raas/providers`'s `FakeEmbeddingProvider`, on
  purpose. `FakeEmbeddingProvider` hashes the whole input string with
  sha256 — deterministic, but deliberately non-semantic: a one-character
  difference produces a completely unrelated vector, so cosine similarity
  between two of its vectors carries no information about whether the
  underlying texts are actually related. That's fine for exercising the
  embedding *pipeline* mechanically (its only job elsewhere in this
  repo), but it would make every fixture's `expectedRelevantChunkIds`
  unverifiable — there'd be no way to know in advance which chunks
  "should" rank highest for a question, since the fake wouldn't encode
  any lexical signal to reason about.

  `LexicalEmbeddingProvider` is a classic hashing-trick bag-of-words
  vector instead: tokens hashed into buckets and counted, so two texts
  that share vocabulary get vectors with real positive cosine similarity.
  Still fully deterministic and offline, but now a fixture author can
  predict, by inspection, roughly what should retrieve for what — see
  `sample-dataset.ts`'s doc comment on choosing topics with disjoint
  vocabulary specifically so this holds. It is not a production embedding
  choice and is never registered anywhere apps/api or apps/worker could
  reach it.

Running fully offline means this framework can run in CI on every PR
(no secrets, no flaky network, no per-run cost) and gives identical output
every time a dataset or a candidate reranker/embedding provider is
compared — a prerequisite for the comparison in step 3 above meaning
anything.
