"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckIcon, FileIcon, UploadCloudIcon, XIcon } from "lucide-react";
import { SUPPORTED_DOCUMENT_MIME_TYPES } from "@raas/shared";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { useUploadDocument } from "@/hooks/use-documents";
import { isApiError } from "@/lib/api-error";
import { Progress } from "@/components/ui/progress";

const ACCEPT = SUPPORTED_DOCUMENT_MIME_TYPES.join(",");
const SUPPORTED_TYPES = new Set<string>(SUPPORTED_DOCUMENT_MIME_TYPES);

interface UploadItem {
  id: string;
  name: string;
  status: "uploading" | "done" | "error";
  progress: number;
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

      // Checked client-side before any network call — the API rejects this
      // too (at presign), but failing here means no upload is even
      // attempted for a file that can never succeed, instead of a
      // multi-second "uploading…" bar that only then errors out.
      if (!SUPPORTED_TYPES.has(file.type)) {
        const message = "Unsupported file type — PDF, DOCX, TXT, MD, or HTML only";
        setItems((prev) => [...prev, { id, name: file.name, status: "error", progress: 0, error: message }]);
        toast.error(`${file.name}: ${message}`);
        continue;
      }

      setItems((prev) => [...prev, { id, name: file.name, status: "uploading", progress: 0 }]);

      uploadDocument.mutate(
        {
          file,
          onProgress: (percent) => {
            setItems((prev) => prev.map((item) => (item.id === id ? { ...item, progress: percent } : item)));
          },
        },
        {
          onSuccess: () => {
            setItems((prev) =>
              prev.map((item) => (item.id === id ? { ...item, status: "done", progress: 100 } : item)),
            );
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
        },
      );
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
          "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-all duration-200",
          isDragging
            ? "scale-[1.01] border-primary bg-accent/40 shadow-sm"
            : "border-border hover:border-primary/40 hover:bg-accent/20",
        )}
      >
        <UploadCloudIcon
          className={cn("size-6 transition-transform duration-200", isDragging ? "scale-110 text-primary" : "text-muted-foreground")}
        />
        <p className="mt-3 text-sm font-medium">Drop files to upload, or click to browse</p>
        <p className="mt-1 text-xs text-muted-foreground">PDF, DOCX, TXT, MD, HTML · up to 1 GB per file</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <div className="space-y-1.5">
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="flex items-center gap-3 overflow-hidden rounded-md border border-border bg-card px-3 py-2.5 text-sm"
              >
                {item.status === "uploading" && <FileIcon className="size-4 shrink-0 text-muted-foreground" />}
                {item.status === "done" && <CheckIcon className="size-4 shrink-0 text-success" />}
                {item.status === "error" && <XIcon className="size-4 shrink-0 text-destructive" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{item.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {item.status === "uploading" && `${item.progress}%`}
                      {item.status === "done" && "Uploaded"}
                      {item.status === "error" && (item.error ?? "Failed")}
                    </span>
                  </div>
                  {item.status === "uploading" && <Progress value={item.progress} className="mt-1.5 h-1" />}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
