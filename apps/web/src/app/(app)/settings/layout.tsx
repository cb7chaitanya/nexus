import type { ReactNode } from "react";

import { PageHeader } from "@/components/layout/page-header";
import { SettingsTabs } from "@/components/settings/settings-tabs";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="pb-16">
      <PageHeader title="Settings" description="Manage your organization, API access, and account." />
      <SettingsTabs />
      <div className="px-6 py-6">{children}</div>
    </div>
  );
}
