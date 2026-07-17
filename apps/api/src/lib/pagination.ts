export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * Wraps a page already fetched with `take: limit` (plus `cursor`/`skip: 1`
 * when a cursor was supplied) into the standard { data, nextCursor }
 * envelope every paginated list endpoint in this API uses. `nextCursor`
 * is the id of the last item on this page — present only when the page
 * was full (exactly `limit` items), since a short page means there's
 * nothing more to fetch.
 */
export function paginate<T extends { id: string }>(items: T[], limit: number): PaginatedResponse<T> {
  return {
    data: items,
    nextCursor: items.length === limit ? items[items.length - 1]!.id : null,
  };
}
