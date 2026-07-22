"use client";

import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "framer-motion";
import { FilterIcon, LayersIcon, QuoteIcon, SparklesIcon, UploadCloudIcon } from "lucide-react";

import { PipelineAnswerPreview } from "@/components/marketing/pipeline-answer-preview";
import { PipelineConnector } from "@/components/marketing/pipeline-connector";
import { PipelineStage } from "@/components/marketing/pipeline-stage";

const STAGES = [
  { icon: UploadCloudIcon, label: "Ingest" },
  { icon: LayersIcon, label: "Process" },
  { icon: FilterIcon, label: "Retrieve" },
  { icon: SparklesIcon, label: "Generate" },
  { icon: QuoteIcon, label: "Cite" },
] as const;

const STAGE_INTERVAL_MS = 1900;

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
        <div className="flex min-w-[560px] items-center">
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
