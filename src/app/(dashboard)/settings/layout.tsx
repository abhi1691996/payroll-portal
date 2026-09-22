import { requirePermission } from "@/server/rbac/guard";
import { SettingsTabs } from "@/components/settings-tabs";
import { PageHeader } from "@/components/ui";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("settings.read", "COMPANY");
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Settings"
        description="Every company runs differently. These rules — working week, shifts, attendance, leave, salary structures, approvals — belong to your company alone."
      />
      <SettingsTabs />
      {children}
    </div>
  );
}
