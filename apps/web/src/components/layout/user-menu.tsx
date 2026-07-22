"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { LogOutIcon, MonitorIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";

import { useSession } from "@/lib/session-context";
import { logout } from "@/lib/api/auth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const themeOptions = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
] as const;

export function UserMenu() {
  const { user } = useSession();
  const { theme, setTheme } = useTheme();
  const router = useRouter();

  const initials = (user.name ?? user.email).slice(0, 1).toUpperCase();

  async function handleLogout() {
    try {
      await logout();
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring">
        <Avatar className="size-7">
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{user.name ?? user.email}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium text-foreground">{user.name ?? "Account"}</p>
          <p className="truncate text-xs">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/settings/profile")}>
          <SettingsIcon /> Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {themeOptions.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => setTheme(option.value)}
            className={theme === option.value ? "bg-accent text-accent-foreground" : undefined}
          >
            <option.icon /> {option.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void handleLogout()}>
          <LogOutIcon /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
