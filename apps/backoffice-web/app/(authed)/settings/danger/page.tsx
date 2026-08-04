import { DangerPanel } from "@/components/settings/panels/danger-panel";
import { SettingsPanel } from "@/components/settings/settings-panel";

export default function DangerSettingsPage() {
  return (
    <SettingsPanel id="danger">
      <DangerPanel />
    </SettingsPanel>
  );
}
