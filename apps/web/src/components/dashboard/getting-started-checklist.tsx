"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { CheckIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

interface Step {
  label: string;
  description: string;
  href?: string;
  done: boolean;
}

function dismissedKey(organizationId: string) {
  return `nexus:onboarding-dismissed:${organizationId}`;
}

export function GettingStartedChecklist({
  organizationId,
  hasKnowledgeBase,
  hasDocument,
  hasConversation,
  createHref,
}: {
  organizationId: string;
  hasKnowledgeBase: boolean;
  hasDocument: boolean;
  hasConversation: boolean;
  createHref: string;
}) {
  const [dismissed, setDismissed] = useState(true);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    setDismissed(localStorage.getItem(dismissedKey(organizationId)) === "true");
  }, [organizationId]);

  const steps: Step[] = [
    { label: "Create a knowledge base", description: "Group related documents together.", done: hasKnowledgeBase },
    { label: "Upload a document", description: "PDFs, text, and markdown are all supported.", done: hasDocument },
    { label: "Start chatting", description: "Ask a question and get a cited answer.", done: hasConversation },
  ];
  const completedCount = steps.filter((s) => s.done).length;
  const allDone = completedCount === steps.length;

  function dismiss() {
    localStorage.setItem(dismissedKey(organizationId), "true");
    setDismissed(true);
  }

  if (dismissed || allDone) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={reducedMotion ? false : { opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reducedMotion ? undefined : { opacity: 0, y: -8 }}
        className="relative overflow-hidden rounded-xl border border-border bg-card p-5"
      >
        <button
          type="button"
          onClick={dismiss}
          className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="Dismiss"
        >
          <XIcon className="size-4" />
        </button>

        <h2 className="text-sm font-semibold">Get started with Nexus</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {completedCount} of {steps.length} steps complete
        </p>
        <Progress value={(completedCount / steps.length) * 100} className="mt-3 max-w-xs" />

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {steps.map((step, index) => {
            const content = (
              <div
                className={cn(
                  "flex h-full flex-col gap-2 rounded-lg border p-3.5 transition-all duration-200",
                  step.done
                    ? "border-success/30 bg-success/5"
                    : "border-border bg-background hover:border-foreground/20",
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
                      step.done ? "bg-success text-success-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {step.done ? <CheckIcon className="size-3" /> : index + 1}
                  </span>
                  <span className="text-sm font-medium">{step.label}</span>
                </div>
                <p className="text-xs text-muted-foreground">{step.description}</p>
              </div>
            );

            return step.href && !step.done ? (
              <Link key={step.label} href={step.href} className="block h-full">
                {content}
              </Link>
            ) : (
              <div key={step.label}>{content}</div>
            );
          })}
        </div>

        {!hasKnowledgeBase && (
          <Button size="sm" className="mt-4" asChild>
            <Link href={createHref}>Create your first knowledge base</Link>
          </Button>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
