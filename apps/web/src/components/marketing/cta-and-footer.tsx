import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";

export function CtaSection() {
  return (
    <section className="border-t border-border/60 py-24">
      <div className="mx-auto max-w-6xl px-6 text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-balance">
          Ready to give your product a memory?
        </h2>
        <p className="mx-auto mt-3 max-w-md text-muted-foreground text-pretty">
          Create your first knowledge base in under five minutes.
        </p>
        <Button size="lg" className="mt-8" asChild>
          <Link href="/signup">
            Start building free <ArrowRightIcon />
          </Link>
        </Button>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border/60 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-sm text-muted-foreground sm:flex-row">
        <Logo className="text-foreground" />
        <p>&copy; {new Date().getFullYear()} Nexus. All rights reserved.</p>
      </div>
    </footer>
  );
}
