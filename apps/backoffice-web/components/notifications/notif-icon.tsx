import { createElement } from "react";
import { iconFor } from "@/lib/notifications/icons";

/**
 * Renders a lucide icon resolved from a kebab-case name (server-shaped data).
 * Resolution goes through createElement so the icon identity stays an existing
 * component rather than one declared during render.
 */
export function NotifIcon({ name, className }: { name: string; className?: string }) {
  return createElement(iconFor(name), { className });
}
