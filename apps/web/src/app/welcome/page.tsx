import Link from "next/link";
import { ArrowRightIcon, CheckCircle2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";

export const metadata = { title: "Welcome" };

export default function WelcomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success">
        <CheckCircle2Icon className="size-6" />
      </div>
      <h1 className="mt-6 text-h2 text-balance">You&apos;re all set</h1>
      <p className="mt-3 max-w-sm text-muted-foreground text-pretty">
        Your subscription is being activated — this usually takes a few seconds. Your plan will update automatically.
      </p>
      <Button className="mt-8" asChild>
        <Link href="/dashboard">
          Go to dashboard <ArrowRightIcon />
        </Link>
      </Button>
    </div>
  );
}
