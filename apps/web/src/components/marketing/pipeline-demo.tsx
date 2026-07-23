"use client";

import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "framer-motion";
import {
  CheckCircle2Icon,
  CogIcon,
  FilterIcon,
  LayersIcon,
  NetworkIcon,
  QuoteIcon,
  SparklesIcon,
  UploadCloudIcon,
} from "lucide-react";

import { PipelineAnswerPreview } from "@/components/marketing/pipeline-answer-preview";
import { PipelineConnector } from "@/components/marketing/pipeline-connector";
import { PipelineStage } from "@/components/marketing/pipeline-stage";

const STAGES = [
  { icon: UploadCloudIcon, label: "Upload" },
  { icon: CogIcon, label: "Processing" },
  { icon: LayersIcon, label: "Chunking" },
  { icon: NetworkIcon, label: "Embeddings" },
  { icon: FilterIcon, label: "Retrieval" },
  { icon: SparklesIcon, label: "LLM" },
  { icon: QuoteIcon, label: "Citations" },
  { icon: CheckCircle2Icon, label: "Answer" },
] as const;

const STAGE_INTERVAL_MS = 1600;

export function PipelineDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const inView = useInView(containerRef, { amount: 0.4 });
  const reducedMotion = useReducedMotion();
  const [activeStage, setActiveStage] = useState(0);

  useEffect(() => {
    if (!inView || reducedMotion) return;
    const id = setInterval(() => {
      setActiveStage((stage) => (stage + 1) % STAGES.length);
    }, STAGE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [inView, reducedMotion]);

  const displayStage = reducedMotion ? STAGES.length - 1 : activeStage;

  return (
    <div ref={containerRef} className="rounded-2xl border border-border bg-card/40 p-6 sm:p-10">
      <div className="overflow-x-auto">
        <div className="flex min-w-[880px] items-center">
          {STAGES.map((stage, index) => (
            <div key={stage.label} className="flex flex-1 items-center last:flex-none">
              {index > 0 && <PipelineConnector filled={displayStage >= index} />}
              <PipelineStage
                icon={stage.icon}
                label={stage.label}
                active={displayStage === index}
                complete={displayStage > index}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-10 border-t border-border pt-8">
        <PipelineAnswerPreview stage={displayStage} reducedMotion={reducedMotion ?? false} />
      </div>
    </div>
  );
}
