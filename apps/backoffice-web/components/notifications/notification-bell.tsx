"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, Bell, CheckCheck, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/settings/segmented";
import { compareSeverity, liveNotifications, unreadCount } from "@/lib/notifications/derive";
import { severityMeta } from "@/lib/notifications/meta";
import type { Notification } from "@/lib/notifications/types";
import { useNotificationStore } from "@/stores/notifications";
import { cn } from "@/lib/utils";
import { NotifIcon } from "./notif-icon";

export function NotificationBell() {
  const items = useNotificationStore((s) => s.items);
  const open = useNotificationStore((s) => s.bellOpen);
  const tab = useNotificationStore((s) => s.bellTab);
  const setOpen = useNotificationStore((s) => s.setBellOpen);
  const setTab = useNotificationStore((s) => s.setBellTab);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const dismiss = useNotificationStore((s) => s.dismiss);
  const router = useRouter();

  const unread = unreadCount(items);
  const live = liveNotifications(items);
  const rows = (tab === "unread" ? live.filter((n) => !n.read) : live)
    .slice()
    .sort(compareSeverity);

  const onView = (n: Notification) => {
    markRead(n.id);
    setOpen(false);
    router.push(n.action.href);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative inline-flex size-[34px] items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Bell className="size-4" />
        {unread > 0 ? (
          <span className="absolute -top-1.5 -right-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-background bg-destructive px-1 font-mono text-[10px] font-semibold text-white tabular-nums">
            {unread}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="flex max-h-[calc(100vh-5rem)] w-[436px] max-w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-pop"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-[15px] font-semibold tracking-tight">Notifications</span>
          <Segmented
            value={tab}
            onValueChange={(v) => setTab(v as "unread" | "all")}
            options={[
              { value: "unread", label: "Unread" },
              { value: "all", label: "All" },
            ]}
            aria-label="Filter notifications"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {rows.map((n) => (
            <BellRow key={n.id} n={n} onView={() => onView(n)} onDismiss={() => dismiss(n.id)} />
          ))}
          {rows.length === 0 ? (
            <div className="px-4 py-11 text-center text-muted-foreground">
              <div className="mx-auto inline-flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent">
                <CheckCheck className="size-[18px]" />
              </div>
              <div className="mt-3 text-[13.5px] font-semibold text-foreground">
                You&apos;re all caught up
              </div>
              <div className="mt-0.5 text-[12.5px]">Nothing unread right now.</div>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-secondary px-3 py-2.5">
          <button
            type="button"
            onClick={() => markAllRead()}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
          >
            <CheckCheck className="size-3.5" /> Mark all read
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push("/inbox");
            }}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] font-semibold text-accent transition-colors hover:bg-accent-soft"
          >
            Open full inbox <ArrowRight className="size-3.5" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BellRow({ n, onView, onDismiss }: { n: Notification; onView: () => void; onDismiss: () => void }) {
  const sev = severityMeta[n.severity];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onView}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onView();
        }
      }}
      className={cn(
        "relative flex cursor-pointer gap-3 border-b border-border py-3 pr-3.5 pl-4 transition-colors hover:bg-secondary",
        n.severity === "crit" && "bg-destructive/5",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-[3px]", sev.bar)} />
      {!n.read ? (
        <span className="absolute top-4 left-[7px] size-1.5 rounded-full bg-accent" />
      ) : null}
      <div
        className={cn(
          "mt-px ml-1 inline-flex size-[30px] shrink-0 items-center justify-center rounded-lg",
          sev.tileBg,
          sev.text,
        )}
      >
        <NotifIcon name={n.icon} className="size-[15px]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "truncate text-[13px] tracking-tight",
              n.read ? "font-medium" : "font-semibold",
            )}
          >
            {n.title}
          </span>
          <span className="flex-1" />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
            {n.timeLabel}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            className="-mt-0.5 -mr-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{n.detail}</p>
      </div>
    </div>
  );
}
