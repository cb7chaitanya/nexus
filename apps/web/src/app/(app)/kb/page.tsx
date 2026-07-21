"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { DatabaseIcon, PlusIcon, SearchIcon } from "lucide-react";

import { useSession } from "@/lib/session-context";
import { useKnowledgeBases } from "@/hooks/use-knowledge-bases";
import { PageHeader } from "@/components/layout/page-header";
import { KnowledgeBaseCard } from "@/components/kb/knowledge-base-card";
import { CreateKnowledgeBaseDialog } from "@/components/kb/create-knowledge-base-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function KnowledgeBasesPage() {
  const { currentOrganization } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");

  const knowledgeBases = useKnowledgeBases(currentOrganization.id);

  const kbs = useMemo(() => knowledgeBases.data?.data ?? [], [knowledgeBases.data]);

  const filtered = useMemo(() => {
    if (!search.trim()) return kbs;
    const query = search.trim().toLowerCase();
    return kbs.filter((kb) => kb.name.toLowerCase().includes(query));
  }, [kbs, search]);

  return (
    <div className="pb-16">
      <PageHeader
        title="Knowledge bases"
        description="Isolated document collections, each with its own retrieval scope."
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon /> New knowledge base
          </Button>
        }
      />

      <div className="px-6 py-6">
        {kbs.length > 0 && (
          <div className="relative mb-6 max-w-xs">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search knowledge bases…"
              className="pl-8"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        )}

        {knowledgeBases.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        ) : kbs.length === 0 ? (
          <EmptyState
            icon={DatabaseIcon}
            title="No knowledge bases yet"
            description="Create a knowledge base and upload your first documents to start chatting with them."
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <PlusIcon /> New knowledge base
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No knowledge bases match &ldquo;{search}&rdquo;.
          </p>
        ) : (
          <motion.div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            initial="hidden"
            animate="show"
            variants={{ show: { transition: { staggerChildren: 0.04 } } }}
          >
            {filtered.map((kb) => (
              <motion.div key={kb.id} variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}>
                <KnowledgeBaseCard kb={kb} />
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>

      <CreateKnowledgeBaseDialog
        organizationId={currentOrganization.id}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}
