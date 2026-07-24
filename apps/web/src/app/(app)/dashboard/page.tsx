"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueries } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRightIcon, DatabaseIcon, MessagesSquareIcon, PlusIcon } from "lucide-react";

import { useSession } from "@/lib/session-context";
import { staggerContainer, fadeUp } from "@/lib/motion";
import { useKnowledgeBases } from "@/hooks/use-knowledge-bases";
import { useConversations } from "@/hooks/use-conversations";
import { useUsage } from "@/hooks/use-usage";
import { documentKeys } from "@/hooks/use-documents";
import { listDocuments } from "@/lib/api/documents";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { SystemHealthStrip } from "@/components/dashboard/system-health-strip";
import { UsageSummaryCard } from "@/components/dashboard/usage-summary-card";
import { GettingStartedChecklist } from "@/components/dashboard/getting-started-checklist";
import { KnowledgeBaseCard } from "@/components/kb/knowledge-base-card";
import { CreateKnowledgeBaseDialog } from "@/components/kb/create-knowledge-base-dialog";
import { ConversationListItem } from "@/components/chat/conversation-list-item";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function DashboardPage() {
  const { user, currentOrganization } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  const reducedMotion = useReducedMotion();

  const knowledgeBases = useKnowledgeBases(currentOrganization.id);
  const conversations = useConversations(currentOrganization.id);
  const usage = useUsage(currentOrganization.id);

  const firstName = user.name?.split(" ")[0] ?? user.email.split("@")[0];
  const kbs = knowledgeBases.data?.data ?? [];
  const recentConversations = conversations.data?.data.slice(0, 5) ?? [];

  // Bounded fan-out, same cap and queryKey as SystemHealthStrip — checking
  // just kbs[0] would leave the checklist stuck "incomplete" forever for
  // anyone who uploads to their 2nd+ knowledge base.
  const trackedKbs = kbs.slice(0, 8);
  const documentResults = useQueries({
    queries: trackedKbs.map((kb) => ({
      queryKey: documentKeys(kb.id),
      queryFn: () => listDocuments(kb.id, currentOrganization.id),
      enabled: Boolean(kb.id),
    })),
  });
  const hasDocument = documentResults.some((result) => (result.data?.data.length ?? 0) > 0);

  return (
    <div className="pb-16">
      <PageHeader
        title={`Welcome back, ${firstName}`}
        description={currentOrganization.name}
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon /> New knowledge base
          </Button>
        }
      />

      <div className="space-y-8 px-6 py-6">
        {!knowledgeBases.isLoading && !conversations.isLoading && (
          <GettingStartedChecklist
            organizationId={currentOrganization.id}
            hasKnowledgeBase={kbs.length > 0}
            hasDocument={hasDocument}
            hasConversation={recentConversations.length > 0}
            createHref="/kb"
            uploadHref={kbs[0] ? `/kb/${kbs[0].id}` : "/kb"}
            chatHref={kbs[0] ? `/kb/${kbs[0].id}/chat` : "/kb"}
          />
        )}

        {!knowledgeBases.isLoading && (
          <SystemHealthStrip knowledgeBases={kbs} organizationId={currentOrganization.id} />
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          {knowledgeBases.isLoading || conversations.isLoading || usage.isLoading ? (
            <>
              <Skeleton className="h-[92px] rounded-xl sm:col-span-2" />
              <Skeleton className="h-[176px] rounded-xl" />
            </>
          ) : (
            <>
              <div className="sm:col-span-2">
                <UsageSummaryCard
                  requestCount={usage.data?.totals.requestCount ?? 0}
                  breakdown={usage.data?.breakdown ?? []}
                />
              </div>
              <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
                <StatCard label="Knowledge bases" value={String(kbs.length)} />
                <StatCard label="Conversations" value={String(conversations.data?.data.length ?? 0)} />
              </div>
            </>
          )}
        </div>

        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Knowledge bases</h2>
            {kbs.length > 0 && (
              <Link href="/kb" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                View all <ArrowRightIcon className="size-3.5" />
              </Link>
            )}
          </div>

          {knowledgeBases.isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
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
          ) : reducedMotion ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {kbs.slice(0, 6).map((kb) => (
                <KnowledgeBaseCard key={kb.id} kb={kb} />
              ))}
            </div>
          ) : (
            <motion.div
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              initial="hidden"
              animate="show"
              variants={staggerContainer()}
            >
              {kbs.slice(0, 6).map((kb) => (
                <motion.div key={kb.id} variants={fadeUp}>
                  <KnowledgeBaseCard kb={kb} />
                </motion.div>
              ))}
            </motion.div>
          )}
        </section>

        <section>
          <h2 className="mb-4 text-sm font-semibold">Recent conversations</h2>
          {conversations.isLoading ? (
            <Card className="py-3">
              <CardContent>
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 rounded-md" />
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : recentConversations.length === 0 ? (
            <EmptyState
              icon={MessagesSquareIcon}
              title="No conversations yet"
              description="Open a knowledge base and ask it a question to start your first conversation."
            />
          ) : (
            <Card className="py-3">
              <CardContent>
                <div className="space-y-0.5">
                  {recentConversations.map((conversation) => (
                    <ConversationListItem
                      key={conversation.id}
                      conversation={conversation}
                      href={`/kb/${conversation.knowledgeBaseId}/chat/${conversation.id}`}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </section>
      </div>

      <CreateKnowledgeBaseDialog
        organizationId={currentOrganization.id}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}
