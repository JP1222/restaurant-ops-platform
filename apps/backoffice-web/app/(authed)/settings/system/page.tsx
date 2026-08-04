import { redirect } from "next/navigation";

// Backward-compat redirect. The old two-tab "System settings" page is replaced
// by the settings center: AI tunables now live at /settings/ai, and Clover moved
// under /settings/integrations. Preserves the legacy ?tab= deep links.
export default async function SystemSettingsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  redirect(tab === "clover" ? "/settings/integrations" : "/settings/ai");
}
