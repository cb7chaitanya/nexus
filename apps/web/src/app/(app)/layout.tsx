import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { getServerSession } from "@/lib/api-server";
import { ACTIVE_ORG_COOKIE_NAME } from "@/lib/config";
import { SessionProvider } from "@/lib/session-context";
import { AppShell } from "@/components/layout/app-shell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }
  if (session.organizations.length === 0) {
    redirect("/login");
  }

  const cookieStore = await cookies();
  const preferredOrgId = cookieStore.get(ACTIVE_ORG_COOKIE_NAME)?.value;
  const initialOrganizationId =
    session.organizations.find((org) => org.id === preferredOrgId)?.id ??
    session.organizations[0]!.id;

  return (
    <SessionProvider
      user={session.user}
      organizations={session.organizations}
      initialOrganizationId={initialOrganizationId}
    >
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
