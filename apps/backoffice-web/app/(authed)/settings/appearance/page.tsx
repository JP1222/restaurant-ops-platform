import { AppearancePanel } from "@/components/settings/panels/appearance-panel";
import { SettingsPanel } from "@/components/settings/settings-panel";

export default function AppearanceSettingsPage() {
  return (
    <SettingsPanel id="appearance">
      <AppearancePanel />
    </SettingsPanel>
  );
}
