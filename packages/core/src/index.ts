export type { AssembledContext, AssembledContextChunk, Citation, RetrievedChunk } from "./types.js";

export { embedQuery } from "./retrieval/embed-query.js";
export { searchSimilarChunks } from "./retrieval/similarity-search.js";
export type { SimilaritySearchParams } from "./retrieval/similarity-search.js";

export { assembleContext } from "./context/assemble-context.js";
export type { AssembleContextOptions } from "./context/assemble-context.js";

export { CitationMarkerFilter } from "./citations/marker-filter.js";
export { CITATION_MARKER_REGEX, validateCitations } from "./citations/validate-citations.js";

export { buildChatMessages } from "./prompt/build-messages.js";

export { IdentityReranker } from "./reranking/identity.js";
export type { Reranker, RerankParams } from "./reranking/types.js";
