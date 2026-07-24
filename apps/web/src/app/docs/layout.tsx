import type { ReactNode } from "react";

import { getServerSession } from "@/lib/api-server";
import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/cta-and-footer";
import { DocsNav } from "@/components/docs/docs-nav";

export default async function DocsLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  const isAuthenticated = session !== null;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader isAuthenticated={isAuthenticated} />
      <div className="mx-auto flex w-full max-w-6xl flex-1 items-start gap-12 px-6 py-12">
        <aside className="sticky top-24 hidden w-52 shrink-0 md:block">
          <DocsNav />
        </aside>
        <main className="min-w-0 flex-1 pb-12">{children}</main>
      </div>
      <SiteFooter isAuthenticated={isAuthenticated} />
    </div>
  );
}
