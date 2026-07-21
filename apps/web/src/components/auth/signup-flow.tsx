"use client";

import { useState } from "react";
import Link from "next/link";

import { AuthShell } from "@/components/auth/auth-shell";
import { SignupForm } from "@/components/auth/signup-form";
import { VerifyOtpForm } from "@/components/auth/verify-otp-form";
import type { PendingSignupResponse } from "@/lib/api/auth";

export function SignupFlow() {
  const [pending, setPending] = useState<PendingSignupResponse | null>(null);

  if (pending) {
    return (
      <AuthShell title="Check your email" description="Almost there — verify your email to finish signing up" footer={null}>
        <VerifyOtpForm pendingSignupId={pending.pendingSignupId} email={pending.email} expiresInSeconds={pending.expiresInSeconds} />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      description="Start building with Nexus in minutes"
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <SignupForm onPending={setPending} />
    </AuthShell>
  );
}
