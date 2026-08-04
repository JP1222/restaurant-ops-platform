"use client";

import {
  customerDisplayItemGroups,
  type DisplayLikeTicket
} from "@/lib/customer-display";

type Props = {
  ticket: DisplayLikeTicket;
};

// Keep the row short so four preparing cards always fit the column without the
// list bleeding past the bottom of the 16:9 canvas.
const VISIBLE_ITEM_LIMIT = 2;

export function CustomerDisplayPreparingRow({ ticket }: Props) {
  const itemGroups = customerDisplayItemGroups(ticket);
  const totalUnits = itemGroups.reduce((sum, group) => sum + group.total, 0);
  const readyUnits = itemGroups.reduce((sum, group) => sum + group.ready, 0);
  const percentReady = totalUnits > 0 ? Math.round((readyUnits / totalUnits) * 100) : 0;
  const visibleGroups = itemGroups.slice(0, VISIBLE_ITEM_LIMIT);
  const extraItemCount = Math.max(0, itemGroups.length - visibleGroups.length);

  return (
    <article
      className="customer-display-preparing-row"
      aria-label={`Order ${ticket.orderLabel || ticket.sourceOrderId} preparing`}
    >
      <div className="customer-display-preparing-row-head">
        <strong className="customer-display-preparing-label">
          {ticket.orderLabel || ticket.sourceOrderId}
        </strong>
        {totalUnits > 0 ? (
          <span
            className="customer-display-progress-pill"
            aria-label={`${readyUnits} of ${totalUnits} items ready`}
          >
            {readyUnits}/{totalUnits}
          </span>
        ) : null}
      </div>
      <div className="customer-display-preparing-track" aria-hidden="true">
        <span
          className="customer-display-preparing-track-fill"
          style={{ width: `${percentReady}%` }}
        />
      </div>
      {visibleGroups.length > 0 ? (
        <ul className="customer-display-preparing-items-list">
          {visibleGroups.map((group) => {
            const isReady = group.ready >= group.total;
            return (
              <li
                key={group.name}
                className={`customer-display-preparing-item${isReady ? " is-ready" : ""}`}
              >
                <span
                  className="customer-display-preparing-item-mark"
                  aria-hidden="true"
                >
                  {isReady ? "✓" : ""}
                </span>
                <span className="customer-display-preparing-item-name">
                  {group.name}
                  {group.total > 1 ? (
                    <span className="customer-display-preparing-item-qty"> ×{group.total}</span>
                  ) : null}
                </span>
              </li>
            );
          })}
          {extraItemCount > 0 ? (
            <li className="customer-display-preparing-more">+{extraItemCount} more</li>
          ) : null}
        </ul>
      ) : null}
    </article>
  );
}
