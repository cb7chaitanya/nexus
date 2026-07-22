import { useMutation } from "@tanstack/react-query";

import { createPortalSession } from "@/lib/api/billing";

export function useCreatePortalSession(organizationId: string) {
  return useMutation({
    mutationFn: () => createPortalSession(organizationId),
  });
}
