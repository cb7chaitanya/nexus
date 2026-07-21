"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema, type LoginInput } from "@raas/shared";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { GoogleButton } from "@/components/auth/google-button";
import { login } from "@/lib/api/auth";
import { isApiError } from "@/lib/api-error";

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_failed: "Something went wrong signing in with Google. Please try again.",
  oauth_email_unverified: "Your Google account's email isn't verified — please verify it with Google first.",
};

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  useEffect(() => {
    const error = searchParams.get("error");
    if (error) {
      toast.error(OAUTH_ERROR_MESSAGES[error] ?? "Something went wrong. Please try again.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run once on mount
  }, []);

  async function onSubmit(values: LoginInput) {
    setServerError(null);
    try {
      await login(values);
      const next = searchParams.get("next");
      router.push(next && next.startsWith("/") ? next : "/dashboard");
      router.refresh();
    } catch (error) {
      if (isApiError(error) && (error.status === 401 || error.status === 400)) {
        setServerError("Incorrect email or password.");
      } else if (isApiError(error) && error.status === 429) {
        setServerError("Too many attempts. Please wait a moment and try again.");
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    }
  }

  const next = searchParams.get("next") ?? undefined;

  return (
    <div className="space-y-4">
      <GoogleButton next={next} />
      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-xs text-muted-foreground">OR</span>
        <Separator className="flex-1" />
      </div>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...register("email")} />
          {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" {...register("password")} />
          {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
        </div>
        {serverError && <p className="text-sm text-destructive">{serverError}</p>}
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting && <Loader2Icon className="animate-spin" />}
          Log in
        </Button>
      </form>
    </div>
  );
}
