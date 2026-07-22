import { SiteHeader } from "@/components/marketing/site-header";
import { Hero } from "@/components/marketing/hero";
import { Features } from "@/components/marketing/features";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { TrustSection } from "@/components/marketing/trust-section";
import { PricingSection } from "@/components/marketing/pricing-section";
import { CtaSection, SiteFooter } from "@/components/marketing/cta-and-footer";

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <Features />
        <HowItWorks />
        <TrustSection />
        <PricingSection />
        <CtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
