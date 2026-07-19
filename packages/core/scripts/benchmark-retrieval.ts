/**
 * Retrieval + citation quality benchmark CLI. Unlike
 * `benchmark-vector-search.ts` (query *latency*, needs a live Postgres),
 * this measures retrieval/citation *quality* against a hand-labeled
 * dataset and runs entirely in-memory — no DATABASE_URL, no OpenAI key,
 * no network call, same result every run. See ../EVALUATION.md for the
 * full picture (dataset format, metric definitions, how to evaluate a new
 * reranker or embedding model).
 *
 * Run with: pnpm --filter @raas/core run eval:retrieval
 * Options:
 *   --k=<n>            top-K retrieved per question (default 5)
 *   --reranker=<name>  identity (default) | keyword
 */
import { KeywordOverlapReranker } from "../src/eval/keyword-reranker.js";
import { sampleRetrievalDataset } from "../src/eval/fixtures/sample-dataset.js";
import { runRetrievalBenchmark } from "../src/eval/run-benchmark.js";
import type { EvalReport } from "../src/eval/types.js";
import { IdentityReranker } from "../src/reranking/identity.js";
import type { Reranker } from "../src/reranking/types.js";

const RERANKERS: Record<string, () => Reranker> = {
  identity: () => new IdentityReranker(),
  keyword: () => new KeywordOverlapReranker(),
};

function parseArgs(argv: string[]): { k: number; rerankerName: string } {
  let k = 5;
  let rerankerName = "identity";

  for (const arg of argv) {
    const [flag, value] = arg.split("=");
    if (flag === "--k" && value) k = Number(value);
    if (flag === "--reranker" && value) rerankerName = value;
  }

  return { k, rerankerName };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printReport(report: EvalReport, rerankerName: string): void {
  console.log(`\nDataset: ${report.datasetName}  |  K=${report.k}  |  reranker=${rerankerName}\n`);

  console.log("Per-question:");
  for (const c of report.cases) {
    console.log(
      `  [${c.caseId}] recall@k=${formatPercent(c.recallAtK)} precision@k=${formatPercent(c.precisionAtK)} ` +
        `rr=${c.reciprocalRank.toFixed(2)} citationCoverage=${formatPercent(c.citationCoverage)} ` +
        `unsupportedCitationRate=${formatPercent(c.unsupportedCitationRate)}`,
    );
    console.log(`    question: ${c.question}`);
    console.log(`    retrieved: [${c.retrievedChunkIds.join(", ")}]  cited: [${c.citedChunkIds.join(", ")}]`);
  }

  console.log("\nAggregate:");
  console.log(`  Recall@K:                ${formatPercent(report.aggregate.meanRecallAtK)}`);
  console.log(`  Precision@K:              ${formatPercent(report.aggregate.meanPrecisionAtK)}`);
  console.log(`  MRR:                      ${report.aggregate.mrr.toFixed(3)}`);
  console.log(`  Citation coverage:        ${formatPercent(report.aggregate.meanCitationCoverage)}`);
  console.log(`  Unsupported citation rate: ${formatPercent(report.aggregate.meanUnsupportedCitationRate)}`);
}

async function main(): Promise<void> {
  const { k, rerankerName } = parseArgs(process.argv.slice(2));
  const buildReranker = RERANKERS[rerankerName];
  if (!buildReranker) {
    throw new Error(`Unknown --reranker="${rerankerName}". Known rerankers: ${Object.keys(RERANKERS).join(", ")}`);
  }

  const report = await runRetrievalBenchmark(sampleRetrievalDataset, { k, reranker: buildReranker() });
  printReport(report, rerankerName);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
