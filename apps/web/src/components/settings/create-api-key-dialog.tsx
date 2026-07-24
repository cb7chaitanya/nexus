"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createApiKeySchema, type CreateApiKeyInput } from "@raas/shared";
import { CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateApiKey } from "@/hooks/use-api-keys";

export function CreateApiKeyDialog({
  organizationId,
  open,
  onOpenChange,
}: {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createApiKey = useCreateApiKey(organizationId);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateApiKeyInput>({ resolver: zodResolver(createApiKeySchema) });

  async function onSubmit(values: CreateApiKeyInput) {
    try {
      const { key } = await createApiKey.mutateAsync({
        name: values.name,
        expiresAt: values.expiresAt?.toISOString(),
      });
      setCreatedKey(key);
    } catch {
      toast.error("Couldn't create API key. Please try again.");
    }
  }

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      reset();
      setCreatedKey(null);
      setCopied(false);
    }
    onOpenChange(nextOpen);
  }

  async function copyKey() {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{createdKey ? "Key created" : "New API key"}</DialogTitle>
          <DialogDescription>
            {createdKey
              ? "Copy this key now — you won't be able to see it again."
              : "Use this key to authenticate requests to the public API."}
          </DialogDescription>
        </DialogHeader>

        {createdKey ? (
          <>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
              <span className="flex-1 truncate font-mono text-xs">{createdKey}</span>
              <Button variant="ghost" size="icon-sm" onClick={copyKey} aria-label={copied ? "Copied" : "Copy key"}>
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => handleClose(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" autoFocus placeholder="Production server" {...register("name")} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2Icon className="animate-spin" />}
                Create key
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
