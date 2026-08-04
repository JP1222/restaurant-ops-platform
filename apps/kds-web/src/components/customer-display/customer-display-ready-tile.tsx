"use client";

import {
  customerDisplayItemGroups,
  type DisplayLikeTicket
} from "@/lib/customer-display";

type Props = {
  ticket: DisplayLikeTicket;
  isFresh: boolean;
  isAnnouncing: boolean;
};

const VISIBLE_ITEM_LIMIT = 3;

export function CustomerDisplayReadyTile({ ticket, isFresh, isAnnouncing }: Props) {
  const itemGroups = customerDisplayItemGroups(ticket);
  const visibleGroups = itemGroups.slice(0, VISIBLE_ITEM_LIMIT);
  const extraItemCount = Math.max(0, itemGroups.length - visibleGroups.length);

  const className = [
    "customer-display-ready-tile",
    isFresh ? "is-fresh" : "",
    isAnnouncing ? "is-announcing" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={className}
      aria-label={`Order ${ticket.orderLabel || ticket.sourceOrderId} ready for pickup`}
    >
      <div className="customer-display-ready-tile-head">
        <span className="customer-display-ready-tile-kicker">Order</span>
        <span className="customer-display-ready-tile-badge">Ready</span>
      </div>
      <div className="customer-display-ready-tile-body">
        <strong className="customer-display-ready-tile-label">
          {ticket.orderLabel || ticket.sourceOrderId}
        </strong>
        {visibleGroups.length > 0 ? (
          <ul className="customer-display-ready-tile-items">
            {visibleGroups.map((group) => (
              <li key={group.name}>
                {group.name}
                {group.total > 1 ? (
                  <span className="customer-display-ready-tile-item-qty"> ×{group.total}</span>
                ) : null}
              </li>
            ))}
            {extraItemCount > 0 ? (
              <li className="customer-display-ready-tile-more">+{extraItemCount} more</li>
            ) : null}
          </ul>
        ) : null}
      </div>
    </article>
  );
}
