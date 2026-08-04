import { AddStoreWizard } from "@/components/stores/add-store-wizard";

// The wizard fills the settings content area with its own layout — it intentionally
// does NOT use SettingsPanel (which would add a second header and help rail).
export default function AddStorePage() {
  return <AddStoreWizard />;
}
