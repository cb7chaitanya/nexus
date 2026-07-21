import type { Metadata } from "next";

import { SignupFlow } from "@/components/auth/signup-flow";

export const metadata: Metadata = { title: "Sign up" };

export default function SignupPage() {
  return <SignupFlow />;
}
