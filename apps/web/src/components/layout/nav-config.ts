import type { LucideIcon } from "lucide-react";
import { BarChart3Icon, DatabaseIcon, LayoutDashboardIcon, SettingsIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const primaryNavItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboardIcon },
  { href: "/kb", label: "Knowledge bases", icon: DatabaseIcon },
  { href: "/settings/usage", label: "Usage", icon: BarChart3Icon },
  { href: "/settings/organization", label: "Settings", icon: SettingsIcon },
];
