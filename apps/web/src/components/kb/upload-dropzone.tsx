"use client";

import { useRef, useState } from "react";
import { CheckIcon, Loader2Icon, UploadCloudIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { useUploadDocument } from "@/hooks/use-documents";
import { isApiError } from "@/lib/api-error";

interface UploadItem {
  id: string;
  name: string;
  status: "uploading" | "done" | "error";
  error?: string;
}

export function UploadDropzone({
  knowledgeBaseId,
  organizationId,
}: {
  knowledgeBaseId: string;
  organizationId: string;
}) {
  const uploadDocument = useUploadDocument(knowledgeBaseId, organizationId);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;

    for (const file of Array.from(fileList)) {
      const id = crypto.randomUUID();
      setItems((prev) => [...prev, { id, name: file.name, status: "uploading" }]);

      uploadDocument.mutate(file, {
        onSuccess: () => {
          setItems((prev) => prev.map((item) => (item.id === id ? { ...item, status: "done" } : item)));
          setTimeout(() => {
            setItems((prev) => prev.filter((item) => item.id !== id));
          }, 2500);
        },
        onError: (error) => {
          const message = isApiError(error) ? error.message : "Upload failed";
          setItems((prev) =>
            prev.map((item) => (item.id === id ? { ...item, status: "error", error: message } : item)),
          );
          toast.error(`${file.name}: ${message}`);
        },
      });
    }
  }

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          isDragging ? "border-primary bg-accent/40" : "border-border hover:border-primary/40 hover:bg-accent/20",
        )}
      >
        <UploadCloudIcon className="size-6 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">Drop files to upload, or click to browse</p>
        <p className="mt-1 text-xs text-muted-foreground">PDF, TXT, Markdown, and more · up to 1 GB per file</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <div className="space-y-1.5">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              {item.status === "uploading" && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
              {item.status === "done" && <CheckIcon className="size-4 text-success" />}
              {item.status === "error" && <XIcon className="size-4 text-destructive" />}
              <span className="flex-1 truncate">{item.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {item.status === "uploading" && "Uploading…"}
                {item.status === "done" && "Uploaded"}
                {item.status === "error" && (item.error ?? "Failed")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
