import { NotificationsPanel } from "@/components/settings/panels/notifications-panel";
import { SettingsPanel } from "@/components/settings/settings-panel";

export default function NotificationsSettingsPage() {
  return (
    <SettingsPanel id="notifications">
      <NotificationsPanel />
    </SettingsPanel>
  );
}
