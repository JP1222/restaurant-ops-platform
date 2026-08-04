import type { KdsTicket, KdsTicketItem, KitchenBoardSettings } from "@rop/contracts";

export type BoardStats = {
  openCount: number;
  avgMinutes: number;
  longestMinutes: number;
  readyCount: number;
  priorityCount: number;
};

export type OptimisticBoardAction = "complete" | "recall";
export type OptimisticBoardItemAction = "complete" | "undo";
export type BoardUrgencyTier = "normal" | "warning" | "critical";
export type BoardModifierTone = "neutral" | "accent" | "alert";
export type BoardVisualSettings = {
  urgencyWarningMinutes: number;
  urgencyCriticalMinutes: number;
  urgencyBlinkCritical: boolean;
  modifierDangerKeywords: string[];
  modifierAccentKeywords: string[];
};

export const defaultBoardVisualSettings: BoardVisualSettings = {
  urgencyWarningMinutes: 10,
  urgencyCriticalMinutes: 20,
  urgencyBlinkCritical: true,
  modifierDangerKeywords: ["no", "sin", "without", "allergy", "allergic", "gluten", "gluten-free"],
  modifierAccentKeywords: ["extra", "add", "on side", "sub"]
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }

  return null;
}

function parseKeywordList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const next = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return next.length > 0 ? next : fallback;
}

function recordForValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function boardItemRecord(item: KdsTicketItem) {
  return item as KdsTicketItem & Record<string, unknown>;
}

function cleanDisplayText(value: string | null | undefined) {
  const text = value?.trim();
  return text && text.length > 0 ? text : null;
}

function splitDetailText(value: string | null | undefined) {
  return (cleanDisplayText(value) ?? "")
    .split(/[\r\n;\u2022]+|\s+&\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function pushUniqueDetail(lines: string[], value: string) {
  const normalized = value.toLowerCase();
  if (!lines.some((line) => line.toLowerCase() === normalized)) {
    lines.push(value);
  }
}

function sanitizeOrderChannelLabel(label: string) {
  const next = label
    .replace(/\s+via\s+deliverect\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return next || "Kitchen queue";
}

function describeRawOrderChannel(ticket: Pick<KdsTicket, "source" | "orderType">) {
  return sanitizeOrderChannelLabel(ticket.source ?? ticket.orderType ?? "Kitchen queue");
}

function deriveEditableOrderMeta(ticket: Pick<KdsTicket, "source" | "orderType" | "displayChannelLabel" | "displayFulfillmentTimeLabel">) {
  if (ticket.displayChannelLabel || ticket.displayFulfillmentTimeLabel) {
    return {
      channelLabel: sanitizeOrderChannelLabel(ticket.displayChannelLabel ?? ticket.orderType ?? ticket.source ?? "Kitchen queue"),
      fulfillmentTimeLabel: ticket.displayFulfillmentTimeLabel ?? ""
    };
  }

  const source = ticket.source?.trim() ?? "";
  const orderType = ticket.orderType?.trim() ?? "";
  if (source && orderType && source.toLowerCase().startsWith(orderType.toLowerCase())) {
    const remainder = source.slice(orderType.length).trim();
    const timeMatch = remainder.match(/^at\s+(.+)$/i);
    const fulfillmentTimeLabel = timeMatch?.[1]?.trim();
    if (fulfillmentTimeLabel) {
      return {
        channelLabel: orderType,
        fulfillmentTimeLabel
      };
    }
  }

  return {
    channelLabel: describeRawOrderChannel(ticket),
    fulfillmentTimeLabel: ""
  };
}

export function formatElapsed(minutes: number) {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return `${hours}h ${remaining}m`;
}

export function formatElapsedPrecise(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function getTicketElapsedSeconds(ticket: KdsTicket, now: number) {
  const createdAt = Date.parse(ticket.createdAt);
  if (Number.isNaN(createdAt)) {
    return ticket.elapsedMinutes * 60;
  }

  return Math.max(ticket.elapsedMinutes * 60, Math.floor((now - createdAt) / 1000));
}

export function resolveBoardVisualSettings(
  settings: KitchenBoardSettings | Record<string, unknown> | null | undefined
): BoardVisualSettings {
  const raw = recordForValue(settings);
  const urgencyWarningMinutes = clamp(
    parseInteger(raw.urgencyWarningMinutes) ?? defaultBoardVisualSettings.urgencyWarningMinutes,
    1,
    240
  );
  const criticalCandidate = parseInteger(raw.urgencyCriticalMinutes) ?? defaultBoardVisualSettings.urgencyCriticalMinutes;
  const urgencyCriticalMinutes = clamp(Math.max(urgencyWarningMinutes + 1, criticalCandidate), urgencyWarningMinutes + 1, 480);

  return {
    urgencyWarningMinutes,
    urgencyCriticalMinutes,
    urgencyBlinkCritical:
      typeof raw.urgencyBlinkCritical === "boolean"
        ? raw.urgencyBlinkCritical
        : defaultBoardVisualSettings.urgencyBlinkCritical,
    modifierDangerKeywords: parseKeywordList(raw.modifierDangerKeywords, defaultBoardVisualSettings.modifierDangerKeywords),
    modifierAccentKeywords: parseKeywordList(raw.modifierAccentKeywords, defaultBoardVisualSettings.modifierAccentKeywords)
  };
}

export function getTicketUrgencyTier(
  ticket: KdsTicket,
  now: number,
  settings: KitchenBoardSettings | Record<string, unknown> | null | undefined
): BoardUrgencyTier {
  const elapsedSeconds = getTicketElapsedSeconds(ticket, now);
  const visualSettings = resolveBoardVisualSettings(settings);

  if (elapsedSeconds >= visualSettings.urgencyCriticalMinutes * 60) {
    return "critical";
  }

  if (elapsedSeconds >= visualSettings.urgencyWarningMinutes * 60) {
    return "warning";
  }

  return "normal";
}

export function describeOrderChannel(ticket: KdsTicket) {
  if (ticket.displayChannelLabel && ticket.displayFulfillmentTimeLabel) {
    return `${sanitizeOrderChannelLabel(ticket.displayChannelLabel)} at ${ticket.displayFulfillmentTimeLabel}`;
  }

  if (ticket.displayChannelLabel) {
    return sanitizeOrderChannelLabel(ticket.displayChannelLabel);
  }

  return describeRawOrderChannel(ticket);
}

export function describeEditableOrderChannel(ticket: KdsTicket) {
  return deriveEditableOrderMeta(ticket).channelLabel;
}

export function describeEditableFulfillmentTime(ticket: KdsTicket) {
  return deriveEditableOrderMeta(ticket).fulfillmentTimeLabel;
}

export function sortTickets(tickets: KdsTicket[]) {
  return [...tickets].sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }

    return a.createdAt.localeCompare(b.createdAt);
  });
}

export function applyOptimisticBoardAction(
  ticket: KdsTicket,
  action: OptimisticBoardAction,
  occurredAt: string,
  actor = "Kitchen"
): KdsTicket {
  return {
    ...ticket,
    status: action === "complete" ? "completed" : "ready",
    lastActor: actor,
    updatedAt: occurredAt
  };
}

export function isBoardItemComplete(item: KdsTicketItem) {
  const candidate = boardItemRecord(item);

  return (
    candidate.completed === true ||
    candidate.isCompleted === true ||
    (typeof candidate.completedAt === "string" && candidate.completedAt.length > 0)
  );
}

export function displayNameForBoardItem(item: Pick<KdsTicketItem, "alternateName" | "name">) {
  return cleanDisplayText(item.name) ?? cleanDisplayText(item.alternateName) ?? "Unnamed item";
}

export function displayDetailsForBoardItem(item: Pick<KdsTicketItem, "alternateName" | "note" | "modifiers">) {
  const lines: string[] = [];

  for (const alternateNameLine of splitDetailText(item.alternateName)) {
    pushUniqueDetail(lines, alternateNameLine);
  }

  for (const noteLine of splitDetailText(item.note)) {
    pushUniqueDetail(lines, noteLine);
  }

  for (const modifier of item.modifiers) {
    for (const modifierLine of splitDetailText(modifier)) {
      pushUniqueDetail(lines, modifierLine);
    }
  }

  return lines;
}

export function nextBoardItemAction(item: KdsTicketItem): OptimisticBoardItemAction {
  return isBoardItemComplete(item) ? "undo" : "complete";
}

export function countCompletedItems(ticket: KdsTicket) {
  return ticket.items.reduce((count, item) => count + (isBoardItemComplete(item) ? 1 : 0), 0);
}

function statusAfterOptimisticItemAction(ticket: KdsTicket, items: KdsTicketItem[]): KdsTicket["status"] {
  if (ticket.status === "completed" || ticket.status === "on_hold") {
    return ticket.status;
  }

  const activeItems = items.filter((item) => !item.refunded);
  if (activeItems.length > 0 && activeItems.every(isBoardItemComplete)) {
    return "ready";
  }

  if (ticket.status === "ready" && activeItems.some((item) => !isBoardItemComplete(item))) {
    return "in_progress";
  }

  return ticket.status;
}

export function applyOptimisticItemAction(
  ticket: KdsTicket,
  itemKey: string,
  action: OptimisticBoardItemAction,
  occurredAt: string,
  actor = "Kitchen"
): KdsTicket {
  let changed = false;

  const items = ticket.items.map((item) => {
    if (item.itemKey !== itemKey && item.id !== itemKey) {
      return item;
    }

    changed = true;
    const completed = action === "complete";

    return {
      ...item,
      completed,
      isCompleted: completed,
      completedAt: completed ? occurredAt : null,
      completedBy: completed ? actor : null
    } as KdsTicketItem;
  });

  if (!changed) {
    return ticket;
  }

  return {
    ...ticket,
    status: statusAfterOptimisticItemAction(ticket, items),
    items,
    lastActor: actor,
    updatedAt: occurredAt
  };
}

export function toneForOrderChannel(ticket: KdsTicket) {
  const source = describeOrderChannel(ticket).toLowerCase();

  if (source.includes("drive")) {
    return "teal";
  }

  if (source.includes("pickup") || source.includes("delivery")) {
    return "violet";
  }

  if (source.includes("for here") || source.includes("dine") || source.includes("table")) {
    return "blue";
  }

  if (source.includes("takeout") || source.includes("to-go") || source.includes("togo")) {
    return "amber";
  }

  return "slate";
}

function matchesKeywordList(modifier: string, keywords: string[]) {
  const normalized = modifier.trim().toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.trim().toLowerCase()));
}

export function toneForModifier(
  modifier: string,
  settings: Pick<BoardVisualSettings, "modifierDangerKeywords" | "modifierAccentKeywords"> = defaultBoardVisualSettings
): BoardModifierTone {
  const normalized = modifier.trim().toLowerCase();

  if (!normalized) {
    return "neutral";
  }

  if (matchesKeywordList(normalized, settings.modifierDangerKeywords)) {
    return "alert";
  }

  if (matchesKeywordList(normalized, settings.modifierAccentKeywords)) {
    return "accent";
  }

  return "neutral";
}

export function summarizeBoard(tickets: KdsTicket[]): BoardStats {
  const openCount = tickets.length;
  const totalMinutes = tickets.reduce((sum, ticket) => sum + ticket.elapsedMinutes, 0);
  const longestMinutes = tickets.reduce((max, ticket) => Math.max(max, ticket.elapsedMinutes), 0);

  return {
    openCount,
    avgMinutes: openCount > 0 ? Math.round(totalMinutes / openCount) : 0,
    longestMinutes,
    readyCount: tickets.filter((ticket) => ticket.status === "ready").length,
    priorityCount: tickets.filter((ticket) => ticket.priority > 0).length
  };
}
