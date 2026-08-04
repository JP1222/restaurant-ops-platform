import { redirect } from "next/navigation";

// Settings home: land on the first Account section.
export default function SettingsIndexPage() {
  redirect("/settings/general");
}
