/**
 * Fields every log line in the system should be able to carry so a single
 * log line can be traced back to the request, tenant, and user that
 * produced it. `organizationId` in particular is what ties log output back
 * to the tenant-isolation boundary described in docs/architecture.md §3.1
 * — every log statement inside a tenant-scoped code path should be bound
 * to it.
 */
export interface LogBindings {
  requestId?: string;
  organizationId?: string;
  userId?: string;
  [key: string]: unknown;
}
