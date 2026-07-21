"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/ui/error-state";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <ErrorState
        title="Something went wrong"
        description="We hit an unexpected error loading this page."
        onRetry={reset}
      />
    </div>
  );
}
