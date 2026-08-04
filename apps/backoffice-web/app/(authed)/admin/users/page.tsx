import { redirect } from "next/navigation";

// Moved into the settings center (see settings/team).
export default function AdminUsersRedirect() {
  redirect("/settings/team");
}
