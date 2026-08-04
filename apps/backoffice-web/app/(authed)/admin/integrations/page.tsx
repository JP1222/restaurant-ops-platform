import { redirect } from "next/navigation";

// Moved into the settings center (see settings/integrations).
export default function AdminIntegrationsRedirect() {
  redirect("/settings/integrations");
}
