"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { OtpInput } from "@/components/auth/otp-input";
import { resendSignupOtp, verifySignupOtp } from "@/lib/api/auth";
import { isApiError } from "@/lib/api-error";

const RESEND_COOLDOWN_SECONDS = 30;

function formatCountdown(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VerifyOtpForm({
  pendingSignupId,
  email,
  expiresInSeconds,
}: {
  pendingSignupId: string;
  email: string;
  expiresInSeconds: number;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(expiresInSeconds);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [isResending, setIsResending] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
      setResendCooldown((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (code.length === 6 && !isVerifying) {
      void handleVerify(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the code itself changes
  }, [code]);

  async function handleVerify(fullCode: string) {
    setIsVerifying(true);
    setError(null);
    try {
      await verifySignupOtp({ pendingSignupId, code: fullCode });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setCode("");
      if (isApiError(err) && err.status === 401) {
        setError(err.message);
      } else if (isApiError(err) && err.status === 404) {
        setError("This code has expired. Request a new one below.");
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } finally {
      setIsVerifying(false);
    }
  }

  async function handleResend() {
    setIsResending(true);
    try {
      const result = await resendSignupOtp({ pendingSignupId });
      setSecondsLeft(result.expiresInSeconds);
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      setCode("");
      setError(null);
      toast.success("A new code is on its way.");
    } catch {
      toast.error("Couldn't resend the code. Please try again.");
    } finally {
      setIsResending(false);
    }
  }

  const expired = secondsLeft === 0;

  return (
    <div className="space-y-5">
      <p className="text-center text-sm text-muted-foreground">
        We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>
      </p>

      <OtpInput value={code} onChange={setCode} disabled={isVerifying || expired} autoFocus />

      <div className="flex min-h-5 items-center justify-center">
        {isVerifying ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : error ? (
          <p className="text-center text-sm text-destructive">{error}</p>
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            {expired ? "Code expired" : `Expires in ${formatCountdown(secondsLeft)}`}
          </p>
        )}
      </div>

      <Button
        variant="outline"
        className="w-full"
        onClick={handleResend}
        disabled={isResending || resendCooldown > 0}
      >
        {isResending && <Loader2Icon className="animate-spin" />}
        {resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : "Resend code"}
      </Button>
    </div>
  );
}
