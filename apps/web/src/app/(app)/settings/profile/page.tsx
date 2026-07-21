"use client";

import { format } from "date-fns";
import { BadgeCheckIcon } from "lucide-react";

import { useSession } from "@/lib/session-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

export default function ProfilePage() {
  const { user } = useSession();

  return (
    <div className="max-w-3xl">
      <Card className="py-5">
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center gap-3">
            <Avatar className="size-12">
              <AvatarFallback className="text-base">
                {(user.name ?? user.email).slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="text-sm font-medium">{user.name ?? "Unnamed"}</p>
              <p className="text-sm text-muted-foreground">{user.email}</p>
            </div>
          </div>
          <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">Email status</p>
              <div className="mt-1">
                {user.emailVerified ? (
                  <Badge variant="success">
                    <BadgeCheckIcon /> Verified
                  </Badge>
                ) : (
                  <Badge variant="outline">Unverified</Badge>
                )}
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Member since</p>
              <p className="mt-1 text-sm font-medium">{format(new Date(user.createdAt), "MMMM d, yyyy")}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
