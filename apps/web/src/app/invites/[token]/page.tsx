import { redirect } from "next/navigation";
import type { Metadata } from "next";

import { getServerSession } from "@/lib/api-server";
import { Logo } from "@/components/logo";
import { InviteAcceptCard } from "@/components/auth/invite-accept-card";

export const metadata: Metadata = { title: "Accept invite" };

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await getServerSession();

  if (!session) {
    redirect(`/login?next=${encodeURIComponent(`/invites/${token}`)}`);
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      <Logo className="mb-8" />
      <InviteAcceptCard token={token} />
    </div>
  );
}
