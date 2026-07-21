"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

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
import { useCreateKnowledgeBase } from "@/hooks/use-knowledge-bases";

const formSchema = z.object({ name: z.string().trim().min(1, "Name is required").max(200) });
type FormValues = z.infer<typeof formSchema>;

export function CreateKnowledgeBaseDialog({
  organizationId,
  open,
  onOpenChange,
}: {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const createKnowledgeBase = useCreateKnowledgeBase(organizationId);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  async function onSubmit(values: FormValues) {
    try {
      const kb = await createKnowledgeBase.mutateAsync({
        organizationId,
        name: values.name,
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingDim: 1536,
      });
      toast.success(`${kb.name} created`);
      reset();
      onOpenChange(false);
      router.push(`/kb/${kb.id}`);
    } catch {
      toast.error("Couldn't create knowledge base. Please try again.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New knowledge base</DialogTitle>
          <DialogDescription>
            A knowledge base holds a set of documents with its own isolated retrieval scope.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="kb-name">Name</Label>
            <Input id="kb-name" autoFocus placeholder="Product documentation" {...register("name")} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2Icon className="animate-spin" />}
              Create knowledge base
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
