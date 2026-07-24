"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, PencilIcon } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateOrganization } from "@/lib/api/organizations";
import { useSession } from "@/lib/session-context";
import type { OrganizationWithRole } from "@/lib/types";

export function OrganizationDetailsCard({ organization }: { organization: OrganizationWithRole }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(organization.name);
  const [saving, setSaving] = useState(false);
  const canEdit = organization.role === "OWNER" || organization.role === "ADMIN";

  async function handleSave() {
    setSaving(true);
    try {
      await updateOrganization(organization.id, { name });
      toast.success("Organization updated");
      setEditing(false);
      router.refresh();
    } catch {
      toast.error("Couldn't update organization");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="py-5">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">Organization details</CardTitle>
        <Badge variant="outline" className="uppercase">
          {organization.plan}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Name</p>
          {editing ? (
            <div className="flex gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm" />
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving && <Loader2Icon className="animate-spin" />}
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{organization.name}</p>
              {canEdit && (
                <Button variant="ghost" size="icon-sm" onClick={() => setEditing(true)} aria-label="Edit organization name">
                  <PencilIcon className="size-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Slug</p>
          <p className="font-mono text-sm">{organization.slug}</p>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Your role</p>
          <Badge variant="secondary" className="uppercase">
            {organization.role}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

export function useCanManageOrg() {
  const { currentOrganization } = useSession();
  return currentOrganization.role === "OWNER" || currentOrganization.role === "ADMIN";
}
