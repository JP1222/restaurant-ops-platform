"use client";

import type { DisplayLikeTicket } from "@/lib/customer-display";
import { CustomerDisplayPreparingRow } from "./customer-display-preparing-row";

type Props = {
  tickets: DisplayLikeTicket[];
};

export function CustomerDisplayPreparingColumn({ tickets }: Props) {
  return (
    <section
      className="customer-display-preparing-column"
      aria-label="Orders in progress"
    >
      <header className="customer-display-column-header">
        <span className="customer-display-column-title">Preparing</span>
        <span className="customer-display-column-count">{tickets.length}</span>
      </header>
      {tickets.length === 0 ? (
        <p className="customer-display-column-empty">All caught up</p>
      ) : (
        <ol className="customer-display-preparing-list">
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <CustomerDisplayPreparingRow ticket={ticket} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
