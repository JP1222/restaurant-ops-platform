import { cookies } from "next/headers";
import { getSessionFromCookies } from "@rop/auth/next";
import { StoreSwitcher } from "@/components/locations/store-switcher";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { getBackofficeSessionCookieName } from "@/lib/auth/config";
import { getBackofficeAuthService } from "@/lib/auth/service";
import { TopbarBreadcrumb } from "./topbar-breadcrumb";
import { UserMenu } from "./user-menu";

export async function AppTopbar() {
  const session = await getSessionFromCookies(await cookies(), getBackofficeAuthService(), {
    cookieName: getBackofficeSessionCookieName()
  });

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <TopbarBreadcrumb />
      <div className="flex-1" />
      <StoreSwitcher />
      <NotificationBell />
      {session ? <UserMenu displayName={session.displayName} /> : null}
    </header>
  );
}
