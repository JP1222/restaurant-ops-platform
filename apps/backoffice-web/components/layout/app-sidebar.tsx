"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ChefHat,
  Clock,
  DollarSign,
  GitCompare,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  Package,
  Rocket,
  Settings,
  Sparkles,
  Store,
  Telescope,
  TrendingUp,
  Users,
  UtensilsCrossed
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail
} from "@/components/ui/sidebar";
import { unreadCount } from "@/lib/notifications/derive";
import { useNotificationStore } from "@/stores/notifications";
import { cn } from "@/lib/utils";

type NavItem = {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
};

const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: "Workspace",
    items: [
      { title: "Hub", href: "/hub", icon: LayoutGrid },
      { title: "Inbox", href: "/inbox", icon: Inbox }
    ]
  },
  {
    label: "Analytics",
    items: [
      { title: "Today", href: "/today", icon: LayoutDashboard },
      { title: "Trends", href: "/trends", icon: TrendingUp },
      { title: "Forecast", href: "/forecast", icon: Telescope },
      { title: "Compare", href: "/compare", icon: GitCompare },
      { title: "Menu", href: "/menu", icon: UtensilsCrossed },
      { title: "Costs", href: "/costs", icon: DollarSign },
      { title: "Dayparts", href: "/dayparts", icon: Clock },
      { title: "Guests", href: "/guests", icon: Users }
    ]
  },
  {
    label: "Inventory",
    items: [
      { title: "Inventory", href: "/inventory", icon: Package },
      { title: "Crew", href: "/inventory/crew", icon: ChefHat }
    ]
  },
  {
    label: "Operations",
    items: [
      { title: "System Health", href: "/ops", icon: Activity },
      { title: "Deploy", href: "/operations", icon: Rocket },
      { title: "Stores", href: "/locations", icon: Store }
    ]
  }
];

export function AppSidebar() {
  const pathname = usePathname();
  const unread = useNotificationStore((s) => unreadCount(s.items));

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link
          href="/today"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 font-medium tracking-tight hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Sparkles className="size-5 text-accent" />
          <span className="truncate">Example Kitchen</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {NAV.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const isActive =
                    pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        aria-disabled={item.disabled}
                        className={cn(item.disabled && "opacity-70")}
                        tooltip={item.title}
                      >
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                      {item.href === "/inbox" && unread > 0 ? (
                        <SidebarMenuBadge className="bg-destructive font-mono text-white tabular-nums">
                          {unread}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname.startsWith("/settings")}
              tooltip="Settings"
            >
              <Link href="/settings/general">
                <Settings />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
