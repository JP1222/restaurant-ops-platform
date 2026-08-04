import type { KdsAction, KdsTicket } from "@rop/contracts";
import { KdsActionSchema } from "@rop/contracts";
import { KdsAction as DbAction, KdsTicketStatus as DbStatus } from "@rop/db-kds";

export function dbStatusToContract(status: DbStatus): KdsTicket["status"] {
  switch (status) {
    case DbStatus.ON_HOLD:
      return "on_hold";
    case DbStatus.ACKNOWLEDGED:
      return "acknowledged";
    case DbStatus.IN_PROGRESS:
      return "in_progress";
    case DbStatus.READY:
      return "ready";
    case DbStatus.COMPLETED:
      return "completed";
    default:
      return "new";
  }
}

export function contractActionToDb(action: KdsAction) {
  const parsed = KdsActionSchema.parse(action);
  switch (parsed) {
    case "acknowledge":
      return DbAction.ACKNOWLEDGE;
    case "hold":
      return DbAction.HOLD;
    case "fire":
      return DbAction.FIRE;
    case "start":
      return DbAction.START;
    case "ready":
      return DbAction.READY;
    case "complete":
      return DbAction.COMPLETE;
    case "bump":
      return DbAction.BUMP;
    case "recall":
      return DbAction.RECALL;
    default:
      return DbAction.SYNC;
  }
}

export function nextStatus(current: DbStatus, action: KdsAction): DbStatus {
  switch (action) {
    case "acknowledge":
      if (current === DbStatus.COMPLETED) {
        return DbStatus.COMPLETED;
      }
      return DbStatus.ACKNOWLEDGED;
    case "hold":
      if (current === DbStatus.COMPLETED) {
        throw new Error("Cannot hold a completed ticket.");
      }
      return DbStatus.ON_HOLD;
    case "fire":
      if (current !== DbStatus.ON_HOLD) {
        return current;
      }
      return DbStatus.NEW;
    case "start":
      if (current === DbStatus.COMPLETED || current === DbStatus.ON_HOLD) {
        throw new Error("Cannot start a completed ticket.");
      }
      return DbStatus.IN_PROGRESS;
    case "ready":
      if (current === DbStatus.COMPLETED || current === DbStatus.ON_HOLD) {
        throw new Error("Cannot mark a completed ticket as ready.");
      }
      return DbStatus.READY;
    case "complete":
    case "bump":
      return DbStatus.COMPLETED;
    case "recall":
      return DbStatus.READY;
    case "sync":
      return current;
    default:
      return current;
  }
}

export function statusEventType(previous: DbStatus, next: DbStatus) {
  return previous === next ? "ticket.updated" : "ticket.status_changed";
}
