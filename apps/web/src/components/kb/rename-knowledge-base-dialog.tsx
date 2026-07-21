"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateKnowledgeBase } from "@/hooks/use-knowledge-bases";

const formSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  description: z.string().trim().max(2000).optional(),
});
type FormValues = z.infer<typeof formSchema>;

export function RenameKnowledgeBaseDialog({
  knowledgeBaseId,
  organizationId,
  defaultValues,
  open,
  onOpenChange,
}: {
  knowledgeBaseId: string;
  organizationId: string;
  defaultValues: { name: string; description: string | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateKnowledgeBase = useUpdateKnowledgeBase(organizationId, knowledgeBaseId);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: defaultValues.name, description: defaultValues.description ?? "" },
  });

  async function onSubmit(values: FormValues) {
    try {
      await updateKnowledgeBase.mutateAsync({
        name: values.name,
        description: values.description || null,
      });
      toast.success("Knowledge base updated");
      onOpenChange(false);
    } catch {
      toast.error("Couldn't update knowledge base.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit knowledge base</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="edit-kb-name">Name</Label>
            <Input id="edit-kb-name" {...register("name")} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-kb-description">Description</Label>
            <Textarea id="edit-kb-description" rows={3} {...register("description")} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2Icon className="animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
