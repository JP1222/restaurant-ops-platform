import { z } from "zod";

// WebAdminRoleSchema is defined in the ./auth.js leaf (re-exported below via
// `export * from "./auth.js"`); imported here for local use in the AdminUser /
// SelfProfile schemas. Moved out of this barrel so ./tenant.js can reuse it for
// the tenant membership / session-claim DTOs without a circular import.
import { WebAdminRoleSchema } from "./auth.js";

export * from "./ai.js";
export * from "./auth.js";
export * from "./insights.js";
export * from "./inventory.js";
export * from "./inventory-match.js";
export * from "./ip-allowlist.js";
export * from "./location.js";
export * from "./loyalty.js";
export * from "./notifications.js";
export * from "./ops.js";
export * from "./order.js";
export * from "./sentry-scrub.js";
export * from "./settings.js";
export * from "./square.js";
export * from "./tenant.js";

export const kdsTicketStatuses = [
  "new",
  "on_hold",
  "acknowledged",
  "in_progress",
  "ready",
  "completed"
] as const;

export const kdsActions = [
  "acknowledge",
  "hold",
  "fire",
  "start",
  "ready",
  "complete",
  "bump",
  "recall",
  "sync"
] as const;

export const realtimeEventTypes = [
  "ticket.created",
  "ticket.updated",
  "ticket.status_changed"
] as const;

export const orderProviders = [
  "clover",
  "deliverect",
  "demo",
  "square"
] as const;

export const deliverectEnvironments = [
  "staging",
  "production"
] as const;

export const KdsTicketStatusSchema = z.enum(kdsTicketStatuses);
export const KdsActionSchema = z.enum(kdsActions);
export const RealtimeEventTypeSchema = z.enum(realtimeEventTypes);
export const OrderProviderSchema = z.enum(orderProviders);

export const KitchenBoardFilterSchema = z.object({
  allowedOrderTypes: z.array(z.string()).default([]),
  blockedSources: z.array(z.string()).default([]),
  paymentStates: z.array(z.string()).default([]),
  createdAfterMinutes: z.number().int().min(0).max(1440).nullable().default(null),
  searchText: z.string().trim().default(""),
  includeCompleted: z.boolean().default(false),
  soundEnabled: z.boolean().default(true),
  screenPinEnabled: z.boolean().default(false)
});

export const DailyResetTimeSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);

export const KitchenBoardPreferencesSchema = z.object({
  boardTimeZone: z.string().trim().min(1).default("UTC"),
  dailyResetEnabled: z.boolean().default(false),
  dailyResetTime: DailyResetTimeSchema.default("21:00")
});

export const KitchenBoardUrgencySettingsSchema = z.object({
  urgencyWarningMinutes: z.number().int().min(1).max(240).default(10),
  urgencyCriticalMinutes: z.number().int().min(1).max(240).default(20),
  urgencyBlinkCritical: z.boolean().default(true)
});

export const KitchenBoardModifierSettingsSchema = z.object({
  modifierDangerKeywords: z.array(z.string().trim().min(1)).default([
    "no",
    "sin",
    "without",
    "allergy",
    "allergic",
    "gluten",
    "gluten-free"
  ]),
  modifierAccentKeywords: z.array(z.string().trim().min(1)).default([
    "extra",
    "add",
    "on side",
    "sub"
  ])
});

export const CustomerDisplayWeatherUnitSchema = z.enum(["fahrenheit", "celsius"]);

export const CustomerDisplayWeatherSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  zipCode: z
    .string()
    .trim()
    .regex(/^\d{5}(?:-\d{4})?$/, "Use a valid US ZIP code.")
    .default("00000"),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Use a two-letter country code.")
    .default("US"),
  unit: CustomerDisplayWeatherUnitSchema.default("fahrenheit")
});

export const KitchenBoardDisplaySettingsSchema = z.object({
  weather: CustomerDisplayWeatherSettingsSchema.default({
    enabled: true,
    zipCode: "00000",
    countryCode: "US",
    unit: "fahrenheit"
  })
});

export const DeliverectProviderSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  environment: z.enum(deliverectEnvironments).default("staging"),
  externalLocationId: z.string().trim().default(""),
  locationId: z.string().trim().default(""),
  channelLinkId: z.string().trim().default(""),
  apiToken: z.string().trim().default(""),
  hmacSecret: z.string().trim().default(""),
  registerWebhookStatus: z.string().nullable().default(null),
  ordersWebhookStatus: z.string().nullable().default(null),
  lastRegisterWebhookAt: z.string().nullable().default(null),
  lastOrderWebhookAt: z.string().nullable().default(null)
});

export const KitchenBoardProviderSettingsSchema = z.object({
  deliverect: DeliverectProviderSettingsSchema.default({
    enabled: false,
    environment: "staging",
    externalLocationId: "",
    locationId: "",
    channelLinkId: "",
    apiToken: "",
    hmacSecret: "",
    registerWebhookStatus: null,
    ordersWebhookStatus: null,
    lastRegisterWebhookAt: null,
    lastOrderWebhookAt: null
  })
});

export const KitchenBoardSettingsSchema = z.object({
  filter: KitchenBoardFilterSchema,
  boardTimeZone: z.string().trim().min(1).default("UTC"),
  dailyResetEnabled: z.boolean().default(false),
  dailyResetTime: DailyResetTimeSchema.default("21:00"),
  // How often the backend polls Clover for order changes (reconciliation).
  // Operator-tunable so latency can be traded against API volume without a
  // deploy. 3s floor: poll latency bottoms out near the Clover round-trip
  // (~2s), so tighter just burns calls — webhooks are the only path below ~2s.
  reconcileIntervalSeconds: z.number().int().min(3).max(300).default(45),
  display: KitchenBoardDisplaySettingsSchema.default({
    weather: {
      enabled: true,
      zipCode: "00000",
      countryCode: "US",
      unit: "fahrenheit"
    }
  }),
  providers: KitchenBoardProviderSettingsSchema.default({
    deliverect: {
      enabled: false,
      environment: "staging",
      externalLocationId: "",
      locationId: "",
      channelLinkId: "",
      apiToken: "",
      hmacSecret: "",
      registerWebhookStatus: null,
      ordersWebhookStatus: null,
      lastRegisterWebhookAt: null,
      lastOrderWebhookAt: null
    }
  })
})
  .extend(KitchenBoardUrgencySettingsSchema.shape)
  .extend(KitchenBoardModifierSettingsSchema.shape);

export const KdsTicketItemCompletionSchema = z.object({
  completed: z.boolean().default(false),
  completedAt: z.string().nullable().default(null),
  completedBy: z.string().nullable().default(null)
});

export const KdsTicketItemSchema = z.object({
  id: z.string(),
  cloverLineItemId: z.string().nullable(),
  providerLineItemId: z.string().nullable(),
  itemKey: z.string(),
  itemId: z.string().nullable(),
  name: z.string(),
  alternateName: z.string().nullable(),
  note: z.string().nullable(),
  modifiers: z.array(z.string()).default([]),
  quantity: z.number().int().min(1),
  refunded: z.boolean().default(false),
  printed: z.boolean().default(false)
}).extend(KdsTicketItemCompletionSchema.shape);

export const KdsTicketSchema = z.object({
  id: z.string(),
  merchantId: z.string(),
  provider: OrderProviderSchema,
  cloverOrderId: z.string(),
  sourceOrderId: z.string(),
  orderLabel: z.string(),
  status: KdsTicketStatusSchema,
  priority: z.number().int().default(0),
  source: z.string().nullable(),
  orderType: z.string().nullable(),
  paymentState: z.string().nullable(),
  note: z.string().nullable(),
  lastActor: z.string().nullable(),
  heldAt: z.string().nullable(),
  holdUntil: z.string().nullable(),
  displayChannelLabel: z.string().nullable(),
  displayFulfillmentTimeLabel: z.string().nullable(),
  hasLocalEdits: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  elapsedMinutes: z.number().min(0),
  items: z.array(KdsTicketItemSchema)
});

export const KdsOverviewSchema = z.object({
  merchantId: z.string(),
  authStatus: z.string(),
  lastWebhookAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastReconciledAt: z.string().nullable(),
  webhookStatus: z.string().nullable(),
  deadLetterCount: z.number().int().min(0),
  ticketCounts: z.record(KdsTicketStatusSchema, z.number().int().min(0)),
  kdsPin: z.string().nullable()
});

export const TicketSnapshotSchema = z.object({
  merchantId: z.string(),
  serverTime: z.string(),
  serverSeq: z.number().int().min(0).optional(),
  tickets: z.array(KdsTicketSchema),
  filter: KitchenBoardFilterSchema
});

export const CloverWebhookEventSchema = z.object({
  merchantId: z.string(),
  eventId: z.string(),
  topic: z.string().nullable(),
  orderId: z.string().nullable(),
  modifiedTime: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()).default({})
});

export const NormalizedOrderItemSchema = z.object({
  cloverLineItemId: z.string().nullable(),
  providerLineItemId: z.string().nullable(),
  itemKey: z.string(),
  itemId: z.string().nullable(),
  name: z.string(),
  alternateName: z.string().nullable(),
  note: z.string().nullable(),
  modifiers: z.array(z.string()).default([]),
  quantity: z.number().int().min(1),
  // The charged amount for this line, in cents (pre-tax). Optional/nullable so
  // providers that don't surface a price (Deliverect/demo) omit it. The loyalty
  // accrual basis is the sum of eligible lines' priceCents (ADR-0022).
  priceCents: z.number().int().nullable().default(null),
  refunded: z.boolean().default(false),
  printed: z.boolean().default(false)
});

// Order-level money, in cents. All fields nullable: populated best-effort from
// the provider (Clover gives total; subtotal is summed from line prices; tax/tip
// may be absent). For audit/reconciliation + the loyalty liability dashboard —
// the accrual BASIS is recomputed from eligible line prices, not from these.
export const NormalizedOrderAmountsSchema = z.object({
  subtotalCents: z.number().int().nullable().default(null),
  taxCents: z.number().int().nullable().default(null),
  tipCents: z.number().int().nullable().default(null),
  totalCents: z.number().int().nullable().default(null),
  currency: z.string().default("USD")
});

// The customer attached to an order, when one is present. Online orders carry a
// customer + phone (the loyalty accrual key); in-store / anonymous orders have
// none → customer is null → the order earns nothing. `phone` is the provider's
// stored value (loose format) — crm-api canonicalizes to E.164 on accrual
// (ADR-0024); kept loose here so kds-api never owns phone formatting.
export const NormalizedOrderCustomerSchema = z.object({
  phone: z.string().nullable().default(null),
  name: z.string().nullable().default(null)
});

export const NormalizedOrderSchema = z.object({
  provider: OrderProviderSchema,
  merchantId: z.string(),
  orderId: z.string(),
  sourceOrderId: z.string(),
  orderLabel: z.string(),
  source: z.string().nullable(),
  orderType: z.string().nullable(),
  paymentState: z.string().nullable(),
  note: z.string().nullable(),
  priority: z.number().int().default(0),
  createdAt: z.string(),
  modifiedAt: z.string(),
  items: z.array(NormalizedOrderItemSchema),
  amounts: NormalizedOrderAmountsSchema.nullable().default(null),
  // The attached customer (loyalty accrual key), or null for anonymous orders.
  customer: NormalizedOrderCustomerSchema.nullable().default(null)
});

export const TicketActionRequestSchema = z.object({
  action: z.enum(["acknowledge", "hold", "fire", "start", "ready", "complete", "bump", "recall"]),
  actor: z.string().trim().min(1).max(120).default("Kitchen"),
  holdForMinutes: z.number().int().min(1).max(1440).nullable().optional()
});

export const TicketLocalEditRequestSchema = z.object({
  orderLabel: z.string().trim().min(1).max(120),
  channelLabel: z.string().max(120).default(""),
  fulfillmentTimeLabel: z.string().max(80).default(""),
  note: z.string().max(500).default("")
});
export const TicketItemActionRequestSchema = z.object({
  action: z.enum(["complete", "undo"]),
  actor: z.string().trim().min(1).max(120).default("Kitchen")
});

export const TicketActionResponseSchema = z.object({
  ticket: KdsTicketSchema,
  eventType: RealtimeEventTypeSchema
});

export const RealtimeTraceSchema = z.object({
  providerEventId: z.string().optional(),
  webhookReceivedAt: z.string().optional(),
  jobStartedAt: z.string().optional(),
  cloverFetchedAt: z.string().optional(),
  dbCommittedAt: z.string().optional(),
  realtimePublishedAt: z.string().optional()
});

export const RealtimeEventSchema = z.object({
  id: z.string().optional(),
  type: RealtimeEventTypeSchema,
  merchantId: z.string(),
  occurredAt: z.string(),
  seq: z.number().int().min(0).optional(),
  publishedAt: z.string().optional(),
  trace: RealtimeTraceSchema.optional(),
  ticket: KdsTicketSchema
});

export const RealtimeReceiptRequestSchema = z.object({
  eventId: z.string().min(1),
  merchantId: z.string().min(1),
  ticketId: z.string().min(1),
  browserReceivedAt: z.string().min(1),
  renderCommittedAt: z.string().min(1)
});

export type CloverWebhookEvent = z.infer<typeof CloverWebhookEventSchema>;
export type CustomerDisplayWeatherSettings = z.infer<typeof CustomerDisplayWeatherSettingsSchema>;
export type KdsAction = z.infer<typeof KdsActionSchema>;
export type KdsOverview = z.infer<typeof KdsOverviewSchema>;
export type KdsTicket = z.infer<typeof KdsTicketSchema>;
export type KdsTicketItem = z.infer<typeof KdsTicketItemSchema>;
export type KdsTicketItemCompletion = z.infer<typeof KdsTicketItemCompletionSchema>;
export type KdsTicketStatus = z.infer<typeof KdsTicketStatusSchema>;
export type KitchenBoardFilter = z.infer<typeof KitchenBoardFilterSchema>;
export type KitchenBoardDisplaySettings = z.infer<typeof KitchenBoardDisplaySettingsSchema>;
export type KitchenBoardModifierSettings = z.infer<typeof KitchenBoardModifierSettingsSchema>;
export type KitchenBoardPreferences = z.infer<typeof KitchenBoardPreferencesSchema>;
export type KitchenBoardProviderSettings = z.infer<typeof KitchenBoardProviderSettingsSchema>;
export type KitchenBoardSettings = z.infer<typeof KitchenBoardSettingsSchema>;
export type KitchenBoardUrgencySettings = z.infer<typeof KitchenBoardUrgencySettingsSchema>;
export type DeliverectProviderSettings = z.infer<typeof DeliverectProviderSettingsSchema>;
export type NormalizedOrder = z.infer<typeof NormalizedOrderSchema>;
export type NormalizedOrderAmounts = z.infer<typeof NormalizedOrderAmountsSchema>;
export type NormalizedOrderItem = z.infer<typeof NormalizedOrderItemSchema>;
export type NormalizedOrderCustomer = z.infer<typeof NormalizedOrderCustomerSchema>;
export type OrderProvider = z.infer<typeof OrderProviderSchema>;
export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
export type RealtimeReceiptRequest = z.infer<typeof RealtimeReceiptRequestSchema>;
export type RealtimeTrace = z.infer<typeof RealtimeTraceSchema>;
export type TicketActionRequest = z.infer<typeof TicketActionRequestSchema>;
export type TicketItemActionRequest = z.infer<typeof TicketItemActionRequestSchema>;
export type TicketLocalEditRequest = z.infer<typeof TicketLocalEditRequestSchema>;
export type TicketSnapshot = z.infer<typeof TicketSnapshotSchema>;

// -- Admin / KDS device tokens (Phase 4 backoffice-admin migration) ----------

// Device kind: a kitchen KDS board vs a customer-facing order-ready display
// (ADR-0818 Phase-2b). Mirrors the db-kds `KdsDeviceRole` enum (keep in sync).
export const KdsDeviceRoleSchema = z.enum(["KDS", "DISPLAY"]);

export const KdsDeviceSchema = z.object({
  id: z.string(),
  merchantId: z.string(),
  label: z.string(),
  role: KdsDeviceRoleSchema,
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable()
});

export const KdsDeviceListResponseSchema = z.object({
  merchantId: z.string(),
  devices: z.array(KdsDeviceSchema)
});

export const KdsDeviceCreateRequestSchema = z.object({
  merchantId: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(120)
});

export const KdsDeviceCreateResponseSchema = z.object({
  id: z.string(),
  merchantId: z.string(),
  label: z.string(),
  role: KdsDeviceRoleSchema,
  createdAt: z.string(),
  token: z.string()
});

// -- Device pairing (ADR-0818 Phase-2b) --------------------------------------
// Toast-style "pair once via a link" handshake. A manager generates a pairing
// claim for a store (POST .../devices/pair); the device opens the pairUrl and
// redeems the SHORT-LIVED one-time `claimCode` for its DURABLE device token. The
// long-lived token never travels in the pairing URL (that would be the IDOR).
export const KdsDevicePairCreateRequestSchema = z.object({
  merchantId: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(120),
  role: KdsDeviceRoleSchema.default("KDS")
});

export const KdsDevicePairCreateResponseSchema = z.object({
  label: z.string(),
  role: KdsDeviceRoleSchema,
  claimCode: z.string(),
  pairUrl: z.string().url(),
  expiresInSeconds: z.number().int().positive()
});

export const KdsPairRedeemRequestSchema = z.object({
  code: z.string().trim().min(4).max(32)
});

export const KdsPairRedeemResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    token: z.string(),
    merchantId: z.string(),
    role: KdsDeviceRoleSchema
  }),
  z.object({
    ok: z.literal(false),
    reason: z.literal("invalid_or_expired")
  })
]);

export type KdsDeviceRole = z.infer<typeof KdsDeviceRoleSchema>;
export type KdsDevice = z.infer<typeof KdsDeviceSchema>;
export type KdsDeviceListResponse = z.infer<typeof KdsDeviceListResponseSchema>;
export type KdsDeviceCreateRequest = z.infer<typeof KdsDeviceCreateRequestSchema>;
export type KdsDeviceCreateResponse = z.infer<typeof KdsDeviceCreateResponseSchema>;
export type KdsDevicePairCreateRequest = z.infer<typeof KdsDevicePairCreateRequestSchema>;
export type KdsDevicePairCreateResponse = z.infer<typeof KdsDevicePairCreateResponseSchema>;
export type KdsPairRedeemRequest = z.infer<typeof KdsPairRedeemRequestSchema>;
export type KdsPairRedeemResponse = z.infer<typeof KdsPairRedeemResponseSchema>;

// -- Admin / web users + passkeys (Phase 4.2) -------------------------------

// WebAdminRoleSchema moved to ./auth.ts (imported at the top of this file,
// re-exported via `export * from "./auth.js"`) so ./tenant.ts can reuse it.

export const AdminUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: WebAdminRoleSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  passkeyCount: z.number().int().min(0)
});

export const AdminUserListResponseSchema = z.object({
  users: z.array(AdminUserSchema)
});

export const AdminUserCreateRequestSchema = z.object({
  username: z.string().trim().min(2).max(64),
  displayName: z.string().trim().min(1).max(120)
});

export const AdminUserCreateResponseSchema = z.object({
  user: AdminUserSchema,
  setupUrl: z.string().url(),
  expiresInSeconds: z.number().int().positive()
});

export const AdminUserUpdateRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(120)
});

export const AdminUserUpdateResponseSchema = z.object({
  user: AdminUserSchema
});

// Self-service profile (ADR-0029 P2). Returned by the backoffice BFF
// GET/PATCH /api/auth/profile for the logged-in operator's own account. Role is
// READ-ONLY (changing roles is a manage-others / RBAC concern). There is NO
// email channel in the suite, so no email field. `passkeyCount` powers the
// lockout-aware UI. Mirrors the SelfProfile interface in
// apps/backoffice-web/lib/auth/profile.ts.
export const SelfProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: WebAdminRoleSchema,
  passkeyCount: z.number().int().min(0)
});

export const AdminUserPasswordResetResponseSchema = z.object({
  ok: z.literal(true),
  setupUrl: z.string().url(),
  expiresInSeconds: z.number().int().positive()
});

export const AdminUserPasskeySchema = z.object({
  credentialId: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  deviceType: z.string(),
  backedUp: z.boolean(),
  transports: z.array(z.string()).nullable()
});

export const AdminUserPasskeyListResponseSchema = z.object({
  passkeys: z.array(AdminUserPasskeySchema)
});

// Machine error codes emitted by the kds-api admin-user surface (thrown as
// `UserAdminError.code` in apps/kds-api/src/lib/admin-user-service.ts, surfaced
// as `{ error: <code> }` on the wire) and consumed by the backoffice BFF +
// settings UI copy map. Shared here so the thrower and the UI key on the same
// strings rather than drifting hand-written literals.
//
//   - username_taken     — requested username already exists (409)
//   - user_not_found     — target account id does not exist (404)
//   - passkey_not_found  — target credential id does not exist (404)
//   - last_admin         — refused: would delete the only account in the system
//                          (any role)
//   - last_login_method  — refused: would leave the account with no usable login
//                          method (no password AND no passkeys) — lockout guard
//   - last_owner         — refused: would leave the system with zero OWNERs
export const AdminUserErrorCodeSchema = z.enum([
  "username_taken",
  "user_not_found",
  "passkey_not_found",
  "last_admin",
  "last_login_method",
  "last_owner"
]);

// WebAdminRole type moved to ./auth.ts (re-exported via `export * from "./auth.js"`).
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type AdminUserListResponse = z.infer<typeof AdminUserListResponseSchema>;
export type AdminUserCreateRequest = z.infer<typeof AdminUserCreateRequestSchema>;
export type AdminUserCreateResponse = z.infer<typeof AdminUserCreateResponseSchema>;
export type AdminUserUpdateRequest = z.infer<typeof AdminUserUpdateRequestSchema>;
export type AdminUserUpdateResponse = z.infer<typeof AdminUserUpdateResponseSchema>;
export type SelfProfile = z.infer<typeof SelfProfileSchema>;
export type AdminUserPasswordResetResponse = z.infer<typeof AdminUserPasswordResetResponseSchema>;
export type AdminUserPasskey = z.infer<typeof AdminUserPasskeySchema>;
export type AdminUserPasskeyListResponse = z.infer<typeof AdminUserPasskeyListResponseSchema>;
export type AdminUserErrorCode = z.infer<typeof AdminUserErrorCodeSchema>;

// -- Clover integration admin (Phase 4.3) -----------------------------------

export const CloverEnvReadinessItemSchema = z.object({
  name: z.string(),
  ready: z.boolean(),
  detail: z.string()
});

export const CloverIntegrationMerchantSchema = z.object({
  id: z.string(),
  authStatus: z.string(),
  webhookStatus: z.string().nullable(),
  region: z.string().nullable(),
  lastWebhookAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastReconciledAt: z.string().nullable(),
  updatedAt: z.string(),
  isOauthConnected: z.boolean(),
  isLegacyTokenRecord: z.boolean()
});

export const CloverIntegrationDashboardSchema = z.object({
  siteUrl: z.string(),
  alternateLaunchPath: z.string(),
  oauthRedirectUri: z.string(),
  webhookUrl: z.string(),
  defaultOAuthResponse: z.string(),
  initialSubscriptions: z.array(z.string()),
  initialPermissions: z.array(z.string())
});

export const CloverIntegrationSyncStatusSchema = z.object({
  merchantId: z.string().nullable(),
  authStatus: z.string().nullable(),
  webhookStatus: z.string().nullable(),
  lastWebhookAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastReconciledAt: z.string().nullable()
});

export const CloverIntegrationResponseSchema = z.object({
  merchant: CloverIntegrationMerchantSchema.nullable(),
  configuredMerchantId: z.string().nullable(),
  status: CloverIntegrationSyncStatusSchema,
  dashboard: CloverIntegrationDashboardSchema,
  readiness: z.object({
    env: z.array(CloverEnvReadinessItemSchema)
  })
});

export type CloverEnvReadinessItem = z.infer<typeof CloverEnvReadinessItemSchema>;
export type CloverIntegrationMerchant = z.infer<typeof CloverIntegrationMerchantSchema>;
export type CloverIntegrationDashboard = z.infer<typeof CloverIntegrationDashboardSchema>;
export type CloverIntegrationSyncStatus = z.infer<typeof CloverIntegrationSyncStatusSchema>;
export type CloverIntegrationResponse = z.infer<typeof CloverIntegrationResponseSchema>;

// -- Daily Reset admin (Phase 4.4) -------------------------------------------

export const DailyResetScheduleSchema = z.object({
  enabled: z.boolean(),
  timeZone: z.string(),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59)
});

export const DailyResetStatusResponseSchema = z.object({
  merchantId: z.string(),
  schedule: DailyResetScheduleSchema,
  lastResetAt: z.string().nullable()
});

export const DailyResetTriggerRequestSchema = z.object({
  merchantId: z.string().trim().min(1).max(32).optional()
});

export const DailyResetTriggerResponseSchema = z.object({
  ok: z.literal(true),
  merchantId: z.string(),
  resetAt: z.string()
});

export type DailyResetSchedule = z.infer<typeof DailyResetScheduleSchema>;
export type DailyResetStatusResponse = z.infer<typeof DailyResetStatusResponseSchema>;
export type DailyResetTriggerRequest = z.infer<typeof DailyResetTriggerRequestSchema>;
export type DailyResetTriggerResponse = z.infer<typeof DailyResetTriggerResponseSchema>;

// -- Deliverect integration admin (Phase 4.5) --------------------------------

/**
 * Editor-facing view of the Deliverect provider config. Plaintext secrets are
 * always masked here so the response can ride a normal HTTPS-fetch into the
 * browser without leaking the API token or HMAC secret. `apiTokenMask` shows
 * the last 4 characters preceded by bullets; `hmacSecretMask` is a bullet
 * placeholder only (the HMAC secret is high-entropy and the last 4 chars
 * carry no operator-recognizable signal). Both are `null` when no secret has
 * been configured.
 */
export const DeliverectIntegrationConfigSchema = z.object({
  enabled: z.boolean(),
  environment: z.enum(deliverectEnvironments),
  externalLocationId: z.string(),
  providerLocationId: z.string(),
  channelLinkId: z.string(),
  apiTokenMask: z.string().nullable(),
  hmacSecretMask: z.string().nullable(),
  registerWebhookStatus: z.string().nullable(),
  ordersWebhookStatus: z.string().nullable(),
  lastRegisterWebhookAt: z.string().nullable(),
  lastOrderWebhookAt: z.string().nullable()
});

export const DeliverectIntegrationResponseSchema = z.object({
  config: DeliverectIntegrationConfigSchema
});

/**
 * Write payload for the Backoffice Deliverect editor. Secrets are optional:
 * when the editor opens it shows masked placeholders and the operator can
 * leave them blank to keep the existing values. `apiToken` / `hmacSecret`
 * are accepted as plaintext on the wire (HTTPS) and the BFF encrypts them
 * via lib/crypto/encryption.ts before they reach kds-api.
 */
export const DeliverectIntegrationUpdateRequestSchema = z.object({
  enabled: z.boolean(),
  environment: z.enum(deliverectEnvironments),
  externalLocationId: z.string().trim().default(""),
  providerLocationId: z.string().trim().default(""),
  channelLinkId: z.string().trim().default(""),
  apiToken: z.string().min(1).optional(),
  hmacSecret: z.string().min(1).optional()
});

export type DeliverectIntegrationConfig = z.infer<typeof DeliverectIntegrationConfigSchema>;
export type DeliverectIntegrationResponse = z.infer<typeof DeliverectIntegrationResponseSchema>;
export type DeliverectIntegrationUpdateRequest = z.infer<typeof DeliverectIntegrationUpdateRequestSchema>;

// -- Menu engineering (Phase 6) ----------------------------------------------

const numericFromPg = z.union([z.number(), z.string()]);

export const MenuItemRowSchema = z.object({
  item_fingerprint: z.string(),
  item_name: z.string(),
  alternate_name: z.string().nullable(),
  quantity: numericFromPg,
  gross_sales_cents: numericFromPg,
  modifier_total_cents: numericFromPg,
  line_count: numericFromPg,
  modifier_line_count: numericFromPg
});

export const MenuItemsResponseSchema = z.object({
  days: z.number().int(),
  items: z.array(MenuItemRowSchema)
});

export const MenuItemHourlyRowSchema = z.object({
  business_date: z.string(),
  local_hour: numericFromPg,
  quantity: numericFromPg,
  gross_sales_cents: numericFromPg,
  line_count: numericFromPg
});

export const MenuItemHourlyResponseSchema = z.object({
  item_fingerprint: z.string(),
  days: z.number().int(),
  rows: z.array(MenuItemHourlyRowSchema)
});

export const MenuItemModifierRowSchema = z.object({
  modifier_name: z.string(),
  modifier_count: numericFromPg,
  modifier_total_cents: numericFromPg,
  attach_rate: z
    .union([z.number(), z.string()])
    .transform((value: number | string) => Number(value))
    .pipe(z.number().min(0).max(1))
});

export const MenuItemModifiersResponseSchema = z.object({
  item_fingerprint: z.string(),
  days: z.number().int(),
  line_count: numericFromPg,
  modifiers: z.array(MenuItemModifierRowSchema)
});

// Shared quadrant vocabulary (star / plowhorse / puzzle / dog). The
// menu-engineering view model itself is computed client-side in backoffice-web
// (lib/menu/kasavana-smith.ts) from the analytics-api inputs feed, so only the
// enum lives in the cross-language contract surface.
export const MenuQuadrantSchema = z.enum(["star", "plowhorse", "puzzle", "dog"]);

export type MenuItemRow = z.infer<typeof MenuItemRowSchema>;
export type MenuItemsResponse = z.infer<typeof MenuItemsResponseSchema>;
export type MenuItemHourlyRow = z.infer<typeof MenuItemHourlyRowSchema>;
export type MenuItemHourlyResponse = z.infer<typeof MenuItemHourlyResponseSchema>;
export type MenuItemModifierRow = z.infer<typeof MenuItemModifierRowSchema>;
export type MenuItemModifiersResponse = z.infer<typeof MenuItemModifiersResponseSchema>;
export type MenuQuadrant = z.infer<typeof MenuQuadrantSchema>;
