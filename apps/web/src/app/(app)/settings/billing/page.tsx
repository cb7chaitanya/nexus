"use client";

import { CreditCardIcon, ExternalLinkIcon } from "lucide-react";
import { toast } from "sonner";

import { useSession } from "@/lib/session-context";
import { useCreatePortalSession } from "@/hooks/use-billing";
import { PaddleCheckoutButton } from "@/components/billing/paddle-checkout-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "outline"> = {
  active: "success",
  trialing: "success",
  past_due: "warning",
  paused: "warning",
  canceled: "outline",
};

export default function BillingPage() {
  const { currentOrganization, user } = useSession();
  const createPortalSession = useCreatePortalSession(currentOrganization.id);
  const canManage = currentOrganization.role === "OWNER" || currentOrganization.role === "ADMIN";

  const hasSubscription = Boolean(currentOrganization.paddleCustomerId);

  async function handleManageBilling() {
    try {
      const { url } = await createPortalSession.mutateAsync();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      toast.error("Couldn't open the billing portal. Please try again.");
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card className="py-5">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Plan</CardTitle>
          <Badge variant="outline" className="uppercase">
            {currentOrganization.plan}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {currentOrganization.subscriptionStatus && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              Subscription status:
              <Badge variant={STATUS_VARIANT[currentOrganization.subscriptionStatus] ?? "outline"} className="capitalize">
                {currentOrganization.subscriptionStatus.replace("_", " ")}
              </Badge>
            </p>
          )}

          {!canManage ? (
            <p className="text-sm text-muted-foreground">Only an owner or admin can manage billing for this organization.</p>
          ) : hasSubscription ? (
            <Button variant="outline" onClick={() => void handleManageBilling()} disabled={createPortalSession.isPending}>
              <CreditCardIcon /> Manage billing <ExternalLinkIcon className="size-3.5" />
            </Button>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                You&apos;re on the Free plan. Upgrade to Pro for multiple knowledge bases, higher limits, and full API access.
              </p>
              <PaddleCheckoutButton organizationId={currentOrganization.id} email={user.email}>
                Upgrade to Pro
              </PaddleCheckoutButton>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
