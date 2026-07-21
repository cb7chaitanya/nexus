"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { ACTIVE_ORG_COOKIE_NAME } from "@/lib/config";
import type { OrganizationWithRole, PublicUser } from "@/lib/types";

interface SessionContextValue {
  user: PublicUser;
  organizations: OrganizationWithRole[];
  currentOrganization: OrganizationWithRole;
  setCurrentOrganizationId: (id: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  user,
  organizations,
  initialOrganizationId,
  children,
}: {
  user: PublicUser;
  organizations: OrganizationWithRole[];
  initialOrganizationId: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [currentOrganizationId, setCurrentOrganizationIdState] = useState(initialOrganizationId);

  const currentOrganization =
    organizations.find((org) => org.id === currentOrganizationId) ?? organizations[0]!;

  const setCurrentOrganizationId = useCallback(
    (id: string) => {
      setCurrentOrganizationIdState(id);
      document.cookie = `${ACTIVE_ORG_COOKIE_NAME}=${id}; path=/; max-age=31536000; samesite=lax`;
      router.refresh();
    },
    [router],
  );

  const value = useMemo(
    () => ({ user, organizations, currentOrganization, setCurrentOrganizationId }),
    [user, organizations, currentOrganization, setCurrentOrganizationId],
  );

  if (!currentOrganization) {
    return null;
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
