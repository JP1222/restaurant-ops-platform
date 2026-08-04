import { GeneralPanel } from "@/components/settings/panels/general-panel";
import { SettingsPanel } from "@/components/settings/settings-panel";

export default function GeneralSettingsPage() {
  return (
    <SettingsPanel id="general">
      <GeneralPanel />
    </SettingsPanel>
  );
}
