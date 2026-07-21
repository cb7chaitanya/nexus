"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, MailCheckIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { acceptInvite } from "@/lib/api/organizations";
import { isApiError } from "@/lib/api-error";

export function InviteAcceptCard({ token }: { token: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleAccept() {
    setStatus("loading");
    try {
      await acceptInvite(token);
      toast.success("You've joined the organization.");
      router.push("/dashboard");
      router.refresh();
    } catch (error) {
      setStatus("error");
      setErrorMessage(
        isApiError(error) && error.status === 404
          ? "This invite link is invalid or has expired."
          : "Something went wrong accepting this invite.",
      );
    }
  }

  return (
    <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-center shadow-sm">
      <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <MailCheckIcon className="size-5" />
      </div>
      <h1 className="mt-4 text-lg font-semibold">You&apos;ve been invited</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Accept this invite to join the organization and start collaborating.
      </p>
      {errorMessage && <p className="mt-4 text-sm text-destructive">{errorMessage}</p>}
      <Button className="mt-6 w-full" onClick={handleAccept} disabled={status === "loading"}>
        {status === "loading" && <Loader2Icon className="animate-spin" />}
        Accept invite
      </Button>
    </div>
  );
}
