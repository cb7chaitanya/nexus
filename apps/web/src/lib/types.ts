// Response DTOs mirrored from apps/api's Prisma models + hand-shaped route
// responses. apps/web deliberately does not depend on @raas/db (that would
// pull Prisma client generation into the standalone Next.js build) — these
// are plain, hand-maintained mirrors of the documented API contracts.

export type OrgRole = "OWNER" | "ADMIN" | "MEMBER";

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  createdAt: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: "free" | "pro" | "enterprise";
  createdAt: string;
  updatedAt: string;
}

export type OrganizationWithRole = Organization & { role: OrgRole };

export interface OrganizationMember {
  id: string;
  userId: string;
  role: OrgRole;
  email: string;
  name: string | null;
  joinedAt: string;
}

export interface OrganizationInvite {
  id: string;
  organizationId: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
}

export interface Workspace {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface PublicApiKey {
  id: string;
  name: string;
  prefix: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export type KnowledgeBaseStatus = "ACTIVE" | "DELETING";

export interface KnowledgeBase {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDim: number;
  status: KnowledgeBaseStatus;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseStats {
  documentCount: number;
  chunkCount: number;
  storageBytes: number;
}

export type KnowledgeBaseDetail = KnowledgeBase & { stats: KnowledgeBaseStats };

export type DocumentStatus =
  | "PENDING_UPLOAD"
  | "QUEUED"
  | "PROCESSING"
  | "READY"
  | "FAILED"
  | "DELETED";

export interface Document {
  id: string;
  organizationId: string;
  knowledgeBaseId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  status: DocumentStatus;
  failureReason: string | null;
  retryCount: number;
  uploadedById: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
  deletedAt: string | null;
}

export interface PresignResponse {
  document: Document;
  uploadUrl: string;
  uploadUrlExpiresAt: string;
}

export interface Citation {
  refId: string;
  chunkId: string;
  documentId: string;
  pageNumber: number | null;
  quote: string;
}

export interface Conversation {
  id: string;
  organizationId: string;
  userId: string;
  knowledgeBaseId: string;
  title: string | null;
  createdAt: string;
}

export type MessageRole = "USER" | "ASSISTANT";

export interface MessageUsageMetadata {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokenSource: "actual" | "estimated";
}

export interface Message {
  id: string;
  organizationId: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  citations: Citation[];
  usageMetadata: MessageUsageMetadata | null;
  createdAt: string;
}

export interface UsageTotals {
  embeddingTokens: number;
  completionTokens: number;
  requestCount: number;
  estimatedCost: number;
}

export type UsageEventType =
  | "CHAT_REQUEST"
  | "CHAT_PROMPT_TOKENS"
  | "CHAT_COMPLETION_TOKENS"
  | "EMBEDDING_TOKENS"
  | "DOCUMENT_PROCESSED";

export interface UsageBreakdownRow {
  date: string;
  eventType: UsageEventType;
  requestCount: number;
  tokens: number;
  cost: number;
}

export interface UsageResponse {
  period: { from: string; to: string };
  totals: UsageTotals;
  breakdown: UsageBreakdownRow[];
  nextCursor: string | null;
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}

export const API_ERROR_CODES = [
  "BAD_REQUEST",
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    details?: { path: string; message: string }[];
  };
}
