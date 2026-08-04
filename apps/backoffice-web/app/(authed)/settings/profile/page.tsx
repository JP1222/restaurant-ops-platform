import { ProfilePanel } from "@/components/settings/panels/profile-panel";
import { SettingsPanel } from "@/components/settings/settings-panel";

export default function ProfileSettingsPage() {
  return (
    <SettingsPanel id="profile">
      <ProfilePanel />
    </SettingsPanel>
  );
}
