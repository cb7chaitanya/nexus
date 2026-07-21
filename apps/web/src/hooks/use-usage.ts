import { useQuery } from "@tanstack/react-query";

import { getUsage } from "@/lib/api/usage";

export function useUsage(
  organizationId: string,
  params: { from?: string; to?: string } = {},
) {
  return useQuery({
    queryKey: ["usage", organizationId, params.from, params.to],
    queryFn: () => getUsage(organizationId, { ...params, limit: 100 }),
    enabled: Boolean(organizationId),
  });
}
