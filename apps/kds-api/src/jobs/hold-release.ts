import type { AppServices } from "../lib/services.js";
import { releaseHeldTickets } from "../lib/sync-order.js";

export async function runHoldReleaseOnce(services: AppServices) {
  return releaseHeldTickets(services);
}
