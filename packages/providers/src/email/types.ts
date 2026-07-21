/**
 * Provider abstraction for transactional email delivery — mirrors
 * EmbeddingProvider/LLMProvider's shape so the send-email job
 * (apps/worker) only ever depends on this interface, not on which
 * provider is actually configured.
 */
export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  send(params: SendEmailParams): Promise<void>;
}
