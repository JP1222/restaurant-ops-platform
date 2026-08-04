import { redirect } from "next/navigation";

// Moved into the settings center (see settings/devices).
export default function AdminDevicesRedirect() {
  redirect("/settings/devices");
}
