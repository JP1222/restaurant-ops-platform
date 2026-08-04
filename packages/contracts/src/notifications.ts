/**
 * Notifications **cross-app** contracts.
 *
 * The operator notification domain (sales/inventory/device/cost/integration
 * alerts surfaced in the backoffice bell + inbox) has no producer/consumer yet:
 * the UI shipped first against a local sample store (PR #798). This module is the
 * **contract-first** boundary for the backend that will back it — a new
 * `notifications-api` (Fastify + its own `db-notifications`, mirroring crm-api /
 * inventory-api) that `apps/backoffice-web` reaches through BFF route handlers.
 * See ADR-0000 (notifications domain) for the why.
 *
 * Why define the shape before either side exists (a reasoned exception to the
 * ADR-0025 "a DTO lives local until it crosses an app boundary" default): both
 * the producer (notifications-api) and the consumer (the backoffice BFF) are
 * net-new, so locking the wire shape first lets them be built in parallel
 * against one agreed contract instead of one chasing the other.
 *
 * Wire shape vs. view-model: this DTO carries `createdAt` (ISO) only. The
 * relative `timeLabel` ("8m", "Yesterday") and the `Today/Yesterday/Earlier`
 * group are **client-derived** (`apps/backoffice-web/lib/notifications/derive`),
 * never sent — they depend on the viewer's clock, so the server must not bake
 * them in. The numeric values inside AI blocks are **pre-formatted display
 * strings** ("$3.2k", "+6.0%", "28%"): presentation the assistant formats
 * server-side, not raw money — so the suite "integer cents" rule does not apply
 * to them (there is no client-side math on these fields).
 */
import { z } from "zod";

/** Triage rank. "info" is neutral/low — distinct from a blue info accent in the UI. */
export const NotificationSeveritySchema = z.enum(["crit", "warn", "info"]);
export type NotificationSeverity = z.infer<typeof NotificationSeveritySchema>;

/** Source domain. Extend as new alert producers land; the UI tints by category. */
export const NotificationCategorySchema = z.enum(["sales", "inv", "dev", "cost", "intg"]);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

export const NotificationChannelSchema = z.enum(["inapp", "email", "push"]);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

/** Per-category floor: all severities / warning & up / critical only. */
export const MinSeveritySchema = z.enum(["all", "warn", "crit"]);
export type MinSeverity = z.infer<typeof MinSeveritySchema>;

/**
 * Deep-link target for a notification's primary action ("View in Trends"). The
 * `href` is an in-app backoffice route; `icon` is a kebab-case lucide name the
 * client resolves to a component.
 */
export const NotificationActionSchema = z.object({
  label: z.string(),
  icon: z.string(),
  href: z.string()
});
export type NotificationAction = z.infer<typeof NotificationActionSchema>;

// ---- AI investigation blocks ----------------------------------------------
// The assistant attaches AT MOST one block, only when it adds value (routine /
// informational items render text-only). A discriminated union on `kind` so the
// consumer narrows exhaustively.

export const BarsBlockSchema = z.object({
  kind: z.literal("bars"),
  label: z.literal("Chart"),
  title: z.string(),
  caption: z.string(),
  cols: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(), // pre-formatted display string
        ratio: z.number().min(0).max(1), // 0..1, bar height
        emphasis: z.boolean().optional()
      })
    )
    .min(1)
});

export const CompareBlockSchema = z.object({
  kind: z.literal("compare"),
  label: z.literal("Comparison"),
  title: z.string(),
  caption: z.string(),
  rows: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        ratio: z.number().min(0).max(1),
        tone: z.enum(["crit", "warn", "info", "neutral", "accent"])
      })
    )
    .min(1)
});

export const StepsBlockSchema = z.object({
  kind: z.literal("steps"),
  label: z.literal("Options"),
  title: z.string(),
  items: z.array(z.object({ text: z.string() })).min(1)
});

export const MetricBlockSchema = z.object({
  kind: z.literal("metric"),
  label: z.literal("Headline"),
  value: z.string(),
  unit: z.string(),
  metricLabel: z.string(),
  delta: z.string(),
  deltaTone: z.enum(["up", "down"])
});

/**
 * A one-click operational fix. It MUTATES live state, so the UI drives a
 * two-step confirm and the server endpoint must be idempotent (on
 * `idempotencyKey`), permission-gated (managers), and audit-logged. The
 * `endpoint` is the notifications-api route the BFF proxies to on confirm.
 */
export const SuggestedActionSchema = z.object({
  id: z.string(),
  applyLabel: z.string(),
  confirmPrompt: z.string(),
  doneLabel: z.string(),
  endpoint: z.string(),
  idempotencyKey: z.string()
});
export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;

export const ActionBlockSchema = z.object({
  kind: z.literal("action"),
  label: z.literal("Suggested action"),
  icon: z.string(),
  title: z.string(),
  hint: z.string(),
  action: SuggestedActionSchema
});

export const AiBlockSchema = z.discriminatedUnion("kind", [
  BarsBlockSchema,
  CompareBlockSchema,
  StepsBlockSchema,
  MetricBlockSchema,
  ActionBlockSchema
]);
export type AiBlock = z.infer<typeof AiBlockSchema>;

export const AiInvestigationSchema = z.object({
  text: z.string(), // always present — the "traceable" explanation
  block: AiBlockSchema.optional() // present only when a component helps
});
export type AiInvestigation = z.infer<typeof AiInvestigationSchema>;

// ---- Notification record ---------------------------------------------------

/**
 * One notification as the notifications-api serves it. Per-viewer interaction
 * state (`read`, `snoozedUntil`, `dismissedAt`) is stored server-side keyed by
 * operator. `ai` is optional + lazy — the list endpoint MAY omit it and let the
 * client fetch the investigation on expand.
 */
export const NotificationSchema = z.object({
  id: z.string(),
  severity: NotificationSeveritySchema,
  category: NotificationCategorySchema,
  categoryLabel: z.string(),
  icon: z.string(),
  title: z.string(),
  detail: z.string(),
  createdAt: z.string().datetime(),
  read: z.boolean(),
  snoozedUntil: z.string().datetime().nullable().optional(),
  dismissedAt: z.string().datetime().nullable().optional(),
  action: NotificationActionSchema,
  ai: AiInvestigationSchema.optional()
});
export type Notification = z.infer<typeof NotificationSchema>;

// ---- Preferences -----------------------------------------------------------

export const CategoryPrefSchema = z.object({
  label: z.string(),
  icon: z.string(),
  inapp: z.boolean(),
  email: z.boolean(),
  push: z.boolean(),
  sev: MinSeveritySchema
});
export type CategoryPref = z.infer<typeof CategoryPrefSchema>;

/**
 * Per-operator delivery preferences. `quietFrom`/`quietTo` are local-time
 * "h:mm AM/PM" labels; quiet hours mute non-critical alerts — critical always
 * reaches in-app regardless (enforced server-side, not just in the UI).
 */
export const NotificationPrefsSchema = z.object({
  quiet: z.boolean(),
  quietFrom: z.string(),
  quietTo: z.string(),
  cats: z.record(NotificationCategorySchema, CategoryPrefSchema)
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

// ---- Request / response DTOs (BFF ↔ notifications-api) ----------------------

export const NotificationListResponseSchema = z.object({
  notifications: z.array(NotificationSchema),
  /** Server's authoritative unread count — the bell badge's source of truth. */
  unreadCount: z.number().int().nonnegative()
});
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

/** Snooze with an explicit wake time; the server validates it is in the future. */
export const SnoozeRequestSchema = z.object({
  until: z.string().datetime()
});
export type SnoozeRequest = z.infer<typeof SnoozeRequestSchema>;

/**
 * A partial preferences patch — only the changed cells travel. Unlike the full
 * state, `cats` is a *partial* record (a toggle patches one category, often one
 * channel), so it is not required to carry every category.
 */
export const UpdatePrefsRequestSchema = z.object({
  quiet: z.boolean().optional(),
  quietFrom: z.string().optional(),
  quietTo: z.string().optional(),
  cats: z.partialRecord(NotificationCategorySchema, CategoryPrefSchema.partial()).optional()
});
export type UpdatePrefsRequest = z.infer<typeof UpdatePrefsRequestSchema>;

/**
 * Confirming a suggested action. `idempotencyKey` dedupes repeated confirms;
 * the server is the gate for manager permission + audit, never the client.
 */
export const ApplyActionRequestSchema = z.object({
  notificationId: z.string(),
  actionId: z.string(),
  idempotencyKey: z.string()
});
export type ApplyActionRequest = z.infer<typeof ApplyActionRequestSchema>;

export const ApplyActionResultSchema = z.object({
  status: z.enum(["applied", "already_applied"]),
  doneLabel: z.string()
});
export type ApplyActionResult = z.infer<typeof ApplyActionResultSchema>;

// ---- Producer ingest (producer → notifications-api) ------------------------

/**
 * A producer (e.g. inventory-api on an 86 / par breach) creating a notification.
 * Only notifications-api writes `db-notifications` (Iron Law 1), so every producer
 * POSTs this shape to its ingest endpoint over HTTP. `dedupeKey` makes ingest
 * idempotent: a retry — or a repeated signal for the same condition — returns the
 * existing row instead of creating a duplicate (e.g. `inv:86:<itemId>` so re-86ing
 * the same item doesn't spam the bell). The per-operator state (read/snooze/
 * dismiss) is layered on at read time; a producer never sets it.
 */
export const IngestNotificationRequestSchema = z.object({
  severity: NotificationSeveritySchema,
  category: NotificationCategorySchema,
  categoryLabel: z.string(),
  icon: z.string(),
  title: z.string(),
  detail: z.string(),
  action: NotificationActionSchema,
  ai: AiInvestigationSchema.optional(),
  /** Store scope (ADR-0018); null/omitted = brand-global. */
  locationId: z.string().nullable().optional(),
  /** Idempotency key; omit for a notification that should always create. */
  dedupeKey: z.string().min(1).optional()
});
export type IngestNotificationRequest = z.infer<typeof IngestNotificationRequestSchema>;

export const IngestNotificationResultSchema = z.object({
  id: z.string(),
  status: z.enum(["created", "duplicate"])
});
export type IngestNotificationResult = z.infer<typeof IngestNotificationResultSchema>;
