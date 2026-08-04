"use client";

import type { DisplayLikeTicket } from "@/lib/customer-display";
import { CustomerDisplayReadyTile } from "./customer-display-ready-tile";

type Props = {
  tickets: DisplayLikeTicket[];
  freshIds: ReadonlySet<string>;
  announcingId: string | null;
};

function CustomerDisplayReadyEmpty() {
  return (
    <div className="customer-display-ready-empty">
      <div className="customer-display-ready-empty-rolls" aria-hidden="true">
        <span className="customer-display-empty-roll" />
        <span className="customer-display-empty-roll" />
        <span className="customer-display-empty-roll" />
      </div>
      <p className="customer-display-ready-empty-text">
        Your rolls are on the way — finished orders pop up here.
      </p>
    </div>
  );
}

export function CustomerDisplayReadyColumn({ tickets, freshIds, announcingId }: Props) {
  return (
    <section
      className="customer-display-ready-column"
      aria-label="Orders ready for pickup"
      aria-live="polite"
      aria-atomic="false"
    >
      <header className="customer-display-column-header is-ready">
        <span className="customer-display-column-title">Ready for Pickup</span>
        <span className="customer-display-column-count is-ready">{tickets.length}</span>
      </header>
      {tickets.length === 0 ? (
        <CustomerDisplayReadyEmpty />
      ) : (
        <div className="customer-display-ready-grid" data-n={Math.min(tickets.length, 6)}>
          {tickets.map((ticket) => (
            <CustomerDisplayReadyTile
              key={ticket.id}
              ticket={ticket}
              isFresh={freshIds.has(ticket.id)}
              isAnnouncing={announcingId === ticket.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}
