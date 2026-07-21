"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowRightIcon,
  DatabaseIcon,
  MessagesSquareIcon,
  PlusIcon,
  ZapIcon,
} from "lucide-react";

import { useSession } from "@/lib/session-context";
import { useKnowledgeBase, useKnowledgeBases } from "@/hooks/use-knowledge-bases";
import { useConversations } from "@/hooks/use-conversations";
import { useUsage } from "@/hooks/use-usage";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { GettingStartedChecklist } from "@/components/dashboard/getting-started-checklist";
import { KnowledgeBaseCard } from "@/components/kb/knowledge-base-card";
import { CreateKnowledgeBaseDialog } from "@/components/kb/create-knowledge-base-dialog";
import { ConversationListItem } from "@/components/chat/conversation-list-item";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const gridVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};
const cardVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
};

export default function DashboardPage() {
  const { user, currentOrganization } = useSession();
  const [createOpen, setCreateOpen] = useState(false);

  const knowledgeBases = useKnowledgeBases(currentOrganization.id);
  const conversations = useConversations(currentOrganization.id);
  const usage = useUsage(currentOrganization.id);

  const firstName = user.name?.split(" ")[0] ?? user.email.split("@")[0];
  const kbs = knowledgeBases.data?.data ?? [];
  const recentConversations = conversations.data?.data.slice(0, 5) ?? [];

  const firstKb = useKnowledgeBase(kbs[0]?.id ?? "", currentOrganization.id);
  const hasDocument = (firstKb.data?.stats.documentCount ?? 0) > 0;

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
          />
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          {knowledgeBases.isLoading || conversations.isLoading || usage.isLoading ? (
            <>
              <Skeleton className="h-[74px] rounded-xl" />
              <Skeleton className="h-[74px] rounded-xl" />
              <Skeleton className="h-[74px] rounded-xl" />
            </>
          ) : (
            <>
              <StatCard label="Knowledge bases" icon={DatabaseIcon} value={String(kbs.length)} />
              <StatCard
                label="Conversations"
                icon={MessagesSquareIcon}
                value={String(conversations.data?.data.length ?? 0)}
              />
              <StatCard
                label="Requests (30d)"
                icon={ZapIcon}
                value={String(usage.data?.totals.requestCount ?? 0)}
              />
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
          ) : (
            <motion.div
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              initial="hidden"
              animate="show"
              variants={gridVariants}
            >
              {kbs.slice(0, 6).map((kb) => (
                <motion.div key={kb.id} variants={cardVariants}>
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
