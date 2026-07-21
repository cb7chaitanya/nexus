"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signupSchema, type SignupInput } from "@raas/shared";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { GoogleButton } from "@/components/auth/google-button";
import { signup, type PendingSignupResponse } from "@/lib/api/auth";
import { isApiError } from "@/lib/api-error";

export function SignupForm({ onPending }: { onPending: (pending: PendingSignupResponse) => void }) {
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({ resolver: zodResolver(signupSchema) });

  async function onSubmit(values: SignupInput) {
    setServerError(null);
    try {
      const pending = await signup(values);
      onPending(pending);
    } catch (error) {
      if (isApiError(error) && error.status === 409) {
        setServerError("An account with this email already exists.");
      } else if (isApiError(error) && error.status === 422) {
        setServerError(error.details?.[0]?.message ?? error.message);
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    }
  }

  return (
    <div className="space-y-4">
      <GoogleButton />
      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-xs text-muted-foreground">OR</span>
        <Separator className="flex-1" />
      </div>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" autoComplete="name" {...register("name")} />
          {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...register("email")} />
          {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" {...register("password")} />
          {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="organizationName">Organization name</Label>
          <Input id="organizationName" autoComplete="organization" {...register("organizationName")} />
          {errors.organizationName && (
            <p className="text-xs text-destructive">{errors.organizationName.message}</p>
          )}
        </div>
        {serverError && <p className="text-sm text-destructive">{serverError}</p>}
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting && <Loader2Icon className="animate-spin" />}
          Create account
        </Button>
      </form>
    </div>
  );
}
