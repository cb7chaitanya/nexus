import Link from "next/link";
import { CompassIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { SubTitle } from "@/components/ui/typography";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <Link href="/" className="mb-8">
        <Logo />
      </Link>
      <div className="flex size-11 items-center justify-center rounded-full bg-muted">
        <CompassIcon className="size-5 text-muted-foreground" />
      </div>
      <SubTitle className="mt-4">Page not found</SubTitle>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
        The page you&apos;re looking for doesn&apos;t exist or may have been moved.
      </p>
      <Button className="mt-6" asChild>
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
