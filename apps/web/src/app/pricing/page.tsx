import { cookies, headers } from "next/headers";

import { getServerSession } from "@/lib/api-server";
import { ACTIVE_ORG_COOKIE_NAME } from "@/lib/config";
import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/cta-and-footer";
import { PricingClient } from "@/components/pricing/pricing-client";

export const metadata = { title: "Pricing" };

export default async function PricingPage() {
  const session = await getServerSession();
  const isAuthenticated = session !== null;

  let organizationId: string | undefined;
  if (session && session.organizations.length > 0) {
    const cookieStore = await cookies();
    const preferredOrgId = cookieStore.get(ACTIVE_ORG_COOKIE_NAME)?.value;
    organizationId = session.organizations.find((org) => org.id === preferredOrgId)?.id ?? session.organizations[0]!.id;
  }

  // Deployed on Railway, not Vercel — this header is almost always absent
  // here (no Railway-native equivalent exists today). Left in place so it
  // still works if this ever moves behind Vercel/a proxy that sets it;
  // when absent, country is simply omitted below and Paddle.PricePreview()
  // falls back to its own IP-based geolocation.
  const headersList = await headers();
  const countryCode = headersList.get("x-vercel-ip-country") ?? undefined;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader isAuthenticated={isAuthenticated} />
      <main className="flex-1">
        <PricingClient
          isAuthenticated={isAuthenticated}
          organizationId={organizationId}
          email={session?.user.email}
          countryCode={countryCode}
        />
      </main>
      <SiteFooter isAuthenticated={isAuthenticated} />
    </div>
  );
}
