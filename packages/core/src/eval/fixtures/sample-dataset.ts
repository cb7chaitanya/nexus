import type { EvalDataset } from "../types.js";

/**
 * A small, hand-labeled retrieval benchmark dataset — four topics with
 * deliberately disjoint vocabulary (biology, databases, history,
 * astronomy), two chunks each. Disjoint vocabulary is a deliberate fixture
 * design choice, not an accident: it's what makes the ground truth below
 * checkable by inspection against `LexicalEmbeddingProvider`'s
 * bag-of-words similarity — a question reusing a topic's own words will
 * score highly against that topic's chunks and near-zero against every
 * other topic's, with no need to run anything to predict the outcome.
 *
 * Two of the four questions (`db-1`, `astro-1`) have TWO expected relevant
 * chunks from the same document, so Recall@K/Precision@K have to do real
 * work (not just "did the one right chunk come back"), and two
 * (`bio-1`, `history-1`) have a single expected chunk but a same-document
 * sibling chunk that shares some vocabulary without answering the
 * question — this is what keeps Precision@K from being trivially 1.0 for
 * every case; see `run-benchmark.test.ts`'s per-case assertions for the
 * exact expected scores this produces.
 *
 * `expectedCitationChunkIds` is deliberately narrower than
 * `expectedRelevantChunkIds` wherever a topic has two chunks: both are
 * legitimately retrievable background, but only one is what a precise
 * answer should actually cite.
 */
export const sampleRetrievalDataset: EvalDataset = {
  name: "sample-retrieval-benchmark",
  chunks: [
    {
      id: "bio-1",
      documentId: "doc-photosynthesis",
      chunkIndex: 0,
      pageNumber: 1,
      content:
        "Photosynthesis is the process by which plants convert sunlight into chemical energy. Chlorophyll in the leaves absorbs light, primarily in the blue and red wavelengths.",
    },
    {
      id: "bio-2",
      documentId: "doc-photosynthesis",
      chunkIndex: 1,
      pageNumber: 2,
      content:
        "The glucose produced by photosynthesis is stored as starch inside the plant cell and later used for growth and energy metabolism.",
    },
    {
      id: "db-1",
      documentId: "doc-postgres",
      chunkIndex: 0,
      pageNumber: 1,
      content:
        "PostgreSQL is an open source relational database. It supports advanced indexing strategies including B-tree, GIN, and HNSW indexes for approximate nearest neighbor search.",
    },
    {
      id: "db-2",
      documentId: "doc-postgres",
      chunkIndex: 1,
      pageNumber: 2,
      content:
        "The pgvector extension adds a vector column type to PostgreSQL, enabling nearest neighbor search using cosine distance or L2 distance operators.",
    },
    {
      id: "history-1",
      documentId: "doc-french-revolution",
      chunkIndex: 0,
      pageNumber: 1,
      content:
        "The French Revolution began in 1789 and led to the abolition of the monarchy. Widespread famine and an economic crisis fueled popular unrest against the crown.",
    },
    {
      id: "history-2",
      documentId: "doc-french-revolution",
      chunkIndex: 1,
      pageNumber: 2,
      content:
        "The Reign of Terror was a period of political violence during the French Revolution, during which thousands of people were executed by guillotine.",
    },
    {
      id: "astro-1",
      documentId: "doc-black-holes",
      chunkIndex: 0,
      pageNumber: 1,
      content:
        "A black hole forms when a massive star collapses under its own gravity at the end of its life cycle, compressing matter into an extremely dense point.",
    },
    {
      id: "astro-2",
      documentId: "doc-black-holes",
      chunkIndex: 1,
      pageNumber: 2,
      content:
        "Black holes can be detected indirectly by observing their gravitational effects on nearby stars and gas, or through imaging of their event horizon shadow.",
    },
  ],
  cases: [
    {
      id: "bio-1",
      question: "How do plants convert sunlight into energy through photosynthesis?",
      expectedRelevantChunkIds: ["bio-1"],
      expectedCitationChunkIds: ["bio-1"],
    },
    {
      id: "db-1",
      question: "What indexing does PostgreSQL support for nearest neighbor vector search?",
      expectedRelevantChunkIds: ["db-1", "db-2"],
      expectedCitationChunkIds: ["db-1"],
    },
    {
      id: "history-1",
      question: "What economic conditions caused the French Revolution to begin in 1789?",
      expectedRelevantChunkIds: ["history-1"],
      expectedCitationChunkIds: ["history-1"],
    },
    {
      id: "astro-1",
      question: "How can astronomers detect a black hole given it emits no light?",
      expectedRelevantChunkIds: ["astro-1", "astro-2"],
      expectedCitationChunkIds: ["astro-2"],
    },
  ],
};
