import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";

export function CtaSection() {
  return (
    <section className="border-t border-border/60 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-6 text-center">
        <h2 className="text-h2 text-balance">Ready to give your product a memory?</h2>
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

export function SiteFooter({ isAuthenticated }: { isAuthenticated: boolean }) {
  return (
    <footer className="border-t border-border/60 py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 sm:flex-row sm:justify-between">
        <div>
          <Logo className="text-foreground" />
          <p className="mt-3 max-w-xs text-sm text-muted-foreground">
            Production-grade retrieval infrastructure for AI products.
          </p>
        </div>
        <div className="flex gap-12 text-sm sm:gap-16">
          <div>
            <p className="font-medium text-foreground">Product</p>
            <ul className="mt-3 space-y-2 text-muted-foreground">
              <li>
                <a href="#features" className="transition-colors hover:text-foreground">
                  Features
                </a>
              </li>
              <li>
                <a href="#how-it-works" className="transition-colors hover:text-foreground">
                  How it works
                </a>
              </li>
              <li>
                <a href="#architecture" className="transition-colors hover:text-foreground">
                  Architecture
                </a>
              </li>
              <li>
                <a href="#pricing" className="transition-colors hover:text-foreground">
                  Pricing
                </a>
              </li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-foreground">Account</p>
            <ul className="mt-3 space-y-2 text-muted-foreground">
              {isAuthenticated ? (
                <li>
                  <Link href="/dashboard" className="transition-colors hover:text-foreground">
                    Dashboard
                  </Link>
                </li>
              ) : (
                <>
                  <li>
                    <Link href="/login" className="transition-colors hover:text-foreground">
                      Log in
                    </Link>
                  </li>
                  <li>
                    <Link href="/signup" className="transition-colors hover:text-foreground">
                      Sign up
                    </Link>
                  </li>
                </>
              )}
            </ul>
          </div>
        </div>
      </div>
      <div className="mx-auto mt-10 max-w-6xl border-t border-border/60 px-6 pt-6 text-sm text-muted-foreground">
        &copy; {new Date().getFullYear()} Nexus. All rights reserved.
      </div>
    </footer>
  );
}
