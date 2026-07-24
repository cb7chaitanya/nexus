import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export function PricingSection() {
  return (
    <section id="pricing" className="border-t border-border/60 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-xl">
          <h2 className="text-h2 text-balance">Plans that grow with your product</h2>
          <p className="mt-3 text-muted-foreground text-pretty">
            Starter, Pro, and Advanced — every plan starts the same way: create an account and ship your first
            knowledge base in minutes.
          </p>
          <Button className="mt-8" asChild>
            <Link href="/pricing">
              View pricing <ArrowRightIcon />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
