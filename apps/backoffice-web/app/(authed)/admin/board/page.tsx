import { redirect } from "next/navigation";

// Moved into the settings center (see settings/board).
export default function AdminBoardRedirect() {
  redirect("/settings/board");
}
