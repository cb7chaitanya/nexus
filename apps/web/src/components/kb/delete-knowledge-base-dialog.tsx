"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon } from "lucide-react";
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
import { useDeleteKnowledgeBase } from "@/hooks/use-knowledge-bases";

export function DeleteKnowledgeBaseDialog({
  knowledgeBaseId,
  knowledgeBaseName,
  organizationId,
  open,
  onOpenChange,
}: {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const deleteKnowledgeBase = useDeleteKnowledgeBase(organizationId);
  const [confirmation, setConfirmation] = useState("");

  async function handleDelete() {
    try {
      await deleteKnowledgeBase.mutateAsync(knowledgeBaseId);
      toast.success(`${knowledgeBaseName} deleted`);
      onOpenChange(false);
      router.push("/kb");
    } catch {
      toast.error("Couldn't delete knowledge base. Please try again.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete knowledge base</DialogTitle>
          <DialogDescription>
            This permanently deletes <strong className="text-foreground">{knowledgeBaseName}</strong>,
            all of its documents, and every conversation tied to it. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-name">
            Type <span className="font-mono">{knowledgeBaseName}</span> to confirm
          </Label>
          <Input id="confirm-name" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={confirmation !== knowledgeBaseName || deleteKnowledgeBase.isPending}
            onClick={handleDelete}
          >
            {deleteKnowledgeBase.isPending && <Loader2Icon className="animate-spin" />}
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
