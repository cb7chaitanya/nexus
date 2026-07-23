"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRightIcon, SparkleIcon } from "lucide-react";

import { duration, ease, transition } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PipelineDemo } from "@/components/marketing/pipeline-demo";

export function Hero() {
  const reducedMotion = useReducedMotion();

  const copy = (
    <div className="mx-auto max-w-2xl text-center">
      <Badge variant="secondary" className="mb-6">
        <SparkleIcon /> Retrieval infrastructure, hosted for you
      </Badge>
      <h1 className="text-display text-balance">The knowledge infrastructure layer for AI.</h1>
      <p className="mx-auto mt-5 max-w-lg text-lg text-muted-foreground text-pretty">
        Upload documents, ship grounded answers with citations, and let Nexus run
        retrieval, chunking, and embeddings underneath.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button size="lg" asChild>
          <Link href="/signup">
            Start building free <ArrowRightIcon />
          </Link>
        </Button>
        <Button size="lg" variant="outline" asChild>
          <a href="#how-it-works">See how it works</a>
        </Button>
      </div>
      <p className="mt-4 text-small text-muted-foreground">
        No credit card required · Free tier included
      </p>
    </div>
  );

  return (
    <section className="overflow-hidden px-6 pb-20 pt-20 md:pb-28 md:pt-28">
      {reducedMotion ? (
        copy
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transition(duration.moderate, ease.emphasized)}
        >
          {copy}
        </motion.div>
      )}

      <div className="mx-auto mt-14 max-w-5xl">
        {reducedMotion ? (
          <PipelineDemo />
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={transition(duration.slow, ease.emphasized)}
          >
            <PipelineDemo />
          </motion.div>
        )}
      </div>
    </section>
  );
}
