"use client";

import type { CustomerAnnouncement } from "@/lib/customer-display";

type Props = {
  announcement: CustomerAnnouncement | null;
};

export function CustomerDisplayNowAnnouncing({ announcement }: Props) {
  if (!announcement) {
    return null;
  }

  const itemSummary =
    announcement.itemNames.length > 0 ? announcement.itemNames.join(" · ") : "Order ready";

  return (
    <div
      className="customer-display-now-announcing"
      role="status"
      aria-live="assertive"
      aria-atomic="true"
    >
      <span className="customer-display-now-announcing-kicker">Now Calling</span>
      <strong className="customer-display-now-announcing-label">{announcement.orderLabel}</strong>
      <span className="customer-display-now-announcing-items">{itemSummary}</span>
    </div>
  );
}
