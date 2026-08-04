export type TicketLikeRealtimeEvent = {
  ticket: {
    id: string;
  };
};

export function coalesceRealtimeEvents<T extends TicketLikeRealtimeEvent>(events: T[]) {
  const latestByTicket = new Map<string, T>();
  for (const event of events) {
    latestByTicket.delete(event.ticket.id);
    latestByTicket.set(event.ticket.id, event);
  }
  return [...latestByTicket.values()];
}

export function createRealtimeCoalescer<T extends TicketLikeRealtimeEvent>(
  flush: (events: T[]) => void
) {
  let queued: T[] = [];
  let frame: number | null = null;

  const flushQueued = () => {
    frame = null;
    const next = queued;
    queued = [];
    if (next.length > 0) {
      flush(coalesceRealtimeEvents(next));
    }
  };

  return {
    push(event: T) {
      queued.push(event);
      if (frame === null) {
        frame = window.requestAnimationFrame(flushQueued);
      }
    },
    flushNow() {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      flushQueued();
    },
    cancel() {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      frame = null;
      queued = [];
    }
  };
}
