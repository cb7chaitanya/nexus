"use client";

import { useState } from "react";
import { UserPlusIcon } from "lucide-react";

import { useSession } from "@/lib/session-context";
import { OrganizationDetailsCard } from "@/components/settings/organization-details-card";
import { MembersTable } from "@/components/settings/members-table";
import { InviteMemberDialog } from "@/components/settings/invite-member-dialog";
import { Button } from "@/components/ui/button";

export default function OrganizationSettingsPage() {
  const { currentOrganization } = useSession();
  const [inviteOpen, setInviteOpen] = useState(false);
  const canManage = currentOrganization.role === "OWNER" || currentOrganization.role === "ADMIN";

  return (
    <div className="max-w-3xl space-y-8">
      <OrganizationDetailsCard organization={currentOrganization} />

      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Members</h2>
          {canManage && (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlusIcon /> Invite member
            </Button>
          )}
        </div>
        <div className="rounded-xl border border-border">
          <MembersTable organizationId={currentOrganization.id} />
        </div>
      </div>

      <InviteMemberDialog organizationId={currentOrganization.id} open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}
