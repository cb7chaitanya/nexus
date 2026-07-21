"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRightIcon, FileTextIcon, SparkleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[38rem] bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,var(--color-primary)_0%,transparent_70%)] opacity-[0.14]"
        aria-hidden
      />
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-20 md:grid-cols-2 md:pb-32 md:pt-28">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        >
          <Badge variant="secondary" className="mb-5">
            <SparkleIcon /> Retrieval-augmented answers, hosted for you
          </Badge>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Turn your documents into a trustworthy AI answer engine
          </h1>
          <p className="mt-5 max-w-lg text-lg text-muted-foreground text-pretty">
            Upload your knowledge base, get a production-ready chat API with citations,
            streaming, and usage controls — no vector database or ML pipeline to build.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg" asChild>
              <Link href="/signup">
                Start building free <ArrowRightIcon />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a href="#how-it-works">See how it works</a>
            </Button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            No credit card required · Free tier included
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
          className="relative"
        >
          <div className="rounded-2xl border border-border bg-card p-4 shadow-2xl shadow-black/10">
            <div className="flex items-center gap-1.5 border-b border-border pb-3">
              <span className="size-2.5 rounded-full bg-destructive/50" />
              <span className="size-2.5 rounded-full bg-warning/60" />
              <span className="size-2.5 rounded-full bg-success/60" />
              <span className="ml-3 text-xs text-muted-foreground">
                Ask your knowledge base
              </span>
            </div>
            <div className="space-y-3 py-4">
              <div className="ml-auto max-w-[85%] rounded-xl rounded-tr-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                What&apos;s our refund policy for enterprise plans?
              </div>
              <div className="max-w-[90%] space-y-2 rounded-xl rounded-tl-sm bg-secondary px-3.5 py-2.5 text-sm">
                <p>
                  Enterprise plans include a 30-day money-back guarantee, prorated for
                  annual commitments after the first billing cycle.
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    <FileTextIcon className="size-3" /> enterprise-terms.pdf · p.4
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
              Ask anything about your documents…
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
