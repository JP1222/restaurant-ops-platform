import { AiPanel } from "@/components/settings/panels/ai-panel";
import { SettingsPanel } from "@/components/settings/settings-panel";

export default function AiSettingsPage() {
  return (
    <SettingsPanel id="ai">
      <AiPanel />
    </SettingsPanel>
  );
}
