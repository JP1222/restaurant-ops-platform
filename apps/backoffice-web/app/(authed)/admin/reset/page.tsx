import { redirect } from "next/navigation";

// Moved into the settings center (see settings/reset).
export default function AdminResetRedirect() {
  redirect("/settings/reset");
}
