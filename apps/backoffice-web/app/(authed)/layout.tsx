import { AiFab } from "@/components/ai/ai-fab";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppTopbar } from "@/components/layout/app-topbar";
import { NotificationsBoot } from "@/components/notifications/notifications-boot";
import { QueryProvider } from "@/components/providers/query-provider";
import { AppearanceBoot } from "@/components/settings/appearance-boot";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <AppearanceBoot />
      <NotificationsBoot />
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <AppTopbar />
          <main className="flex-1 p-6 lg:p-8">{children}</main>
        </SidebarInset>
        <AiFab />
        <Toaster />
      </SidebarProvider>
    </QueryProvider>
  );
}
