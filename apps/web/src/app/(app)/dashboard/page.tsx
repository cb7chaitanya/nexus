"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  DatabaseIcon,
  MessagesSquareIcon,
  PlusIcon,
  ZapIcon,
} from "lucide-react";

import { useSession } from "@/lib/session-context";
import { useKnowledgeBases } from "@/hooks/use-knowledge-bases";
import { useConversations } from "@/hooks/use-conversations";
import { useUsage } from "@/hooks/use-usage";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
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

  const knowledgeBases = useKnowledgeBases(currentOrganization.id);
  const conversations = useConversations(currentOrganization.id);
  const usage = useUsage(currentOrganization.id);

  const firstName = user.name?.split(" ")[0] ?? user.email.split("@")[0];
  const kbs = knowledgeBases.data?.data ?? [];
  const recentConversations = conversations.data?.data.slice(0, 5) ?? [];

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
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            label="Knowledge bases"
            icon={DatabaseIcon}
            value={knowledgeBases.isLoading ? "—" : String(knowledgeBases.data?.data.length ?? 0)}
          />
          <StatCard
            label="Conversations"
            icon={MessagesSquareIcon}
            value={conversations.isLoading ? "—" : String(conversations.data?.data.length ?? 0)}
          />
          <StatCard
            label="Requests (30d)"
            icon={ZapIcon}
            value={usage.isLoading ? "—" : String(usage.data?.totals.requestCount ?? 0)}
          />
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
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {kbs.slice(0, 6).map((kb) => (
                <KnowledgeBaseCard key={kb.id} kb={kb} />
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-4 text-sm font-semibold">Recent conversations</h2>
          <Card className="py-3">
            <CardContent>
              {conversations.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 rounded-md" />
                  ))}
                </div>
              ) : recentConversations.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No conversations yet — start one from a knowledge base.
                </p>
              ) : (
                <div className="space-y-0.5">
                  {recentConversations.map((conversation) => (
                    <ConversationListItem
                      key={conversation.id}
                      conversation={conversation}
                      href={`/kb/${conversation.knowledgeBaseId}/chat/${conversation.id}`}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
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
