"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb";

const ROUTE_LABELS: Record<string, { group: string; title: string }> = {
  "/hub": { group: "Workspace", title: "Hub" },
  "/inbox": { group: "Workspace", title: "Inbox" },
  "/today": { group: "Analytics", title: "Today" },
  "/trends": { group: "Analytics", title: "Trends" },
  "/compare": { group: "Analytics", title: "Compare" },
  "/menu": { group: "Analytics", title: "Menu" },
  "/dayparts": { group: "Analytics", title: "Dayparts" },
  "/settings/general": { group: "Settings", title: "General" },
  "/settings/profile": { group: "Settings", title: "Profile" },
  "/settings/notifications": { group: "Settings", title: "Notifications" },
  "/settings/appearance": { group: "Settings", title: "Appearance" },
  "/settings/ai": { group: "Settings", title: "AI Assistant" },
  "/settings/integrations": { group: "Settings", title: "Integrations" },
  "/settings/devices": { group: "Settings", title: "Devices" },
  "/settings/board": { group: "Settings", title: "Board Settings" },
  "/settings/team": { group: "Settings", title: "Team & Access" },
  "/settings/reset": { group: "Settings", title: "Daily Reset" },
  "/settings/danger": { group: "Settings", title: "Danger Zone" },
  "/inventory": { group: "Inventory", title: "Overview" },
  "/ops": { group: "Operations", title: "System Health" }
};

function getRouteLabel(pathname: string) {
  return ROUTE_LABELS[pathname] ?? { group: "Backoffice", title: "Workspace" };
}

export function TopbarBreadcrumb() {
  const pathname = usePathname();
  const label = getRouteLabel(pathname);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem className="hidden sm:inline-flex">
          <BreadcrumbLink asChild>
            <Link href="/today">{label.group}</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="hidden sm:inline-flex" />
        <BreadcrumbItem>
          <BreadcrumbPage>{label.title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
