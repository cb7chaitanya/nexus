import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getServerSession } from "@/lib/api-server";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  if (session) {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
