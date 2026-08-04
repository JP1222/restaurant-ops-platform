import { z } from "zod";

export const JobTypeSchema = z.enum([
  "webhook_fetch_order",
  "webhook_fetch_payment",
  "reference_data_refresh",
  "mini_rest_sweep",
  "hourly_rest_sweep",
  "export_reconcile",
  "historical_export_backfill",
  "order_detail_hydration",
  "reconciliation_check",
  "repair_window",
  "data_quality_check",
  "forecast_refresh",
  "external_recon",
  "square_sweep"
]);

export type JobType = z.infer<typeof JobTypeSchema>;

const WindowPayloadSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  reason: z.string().optional()
});

export const JobPayloadSchemas = {
  webhook_fetch_order: z.object({
    orderId: z.string().min(1),
    eventTs: z.string().datetime().optional()
  }),
  webhook_fetch_payment: z.object({
    paymentId: z.string().min(1),
    eventTs: z.string().datetime().optional()
  }),
  reference_data_refresh: z.object({
    resource: z.enum(["employees", "tenders", "order_types", "all"]).default("all")
  }),
  mini_rest_sweep: WindowPayloadSchema,
  hourly_rest_sweep: WindowPayloadSchema,
  export_reconcile: WindowPayloadSchema,
  historical_export_backfill: WindowPayloadSchema,
  order_detail_hydration: z.object({
    orderIds: z.array(z.string().min(1)).min(1).max(100),
    rawExportId: z.string().uuid().optional(),
    start: z.string().datetime(),
    end: z.string().datetime(),
    reason: z.string().optional()
  }),
  reconciliation_check: WindowPayloadSchema,
  repair_window: WindowPayloadSchema,
  data_quality_check: z.object({
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional()
  }),
  forecast_refresh: z.object({
    reason: z.string().optional()
  }),
  external_recon: z.object({
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.string().optional()
  }),
  square_sweep: WindowPayloadSchema
} satisfies Record<JobType, z.ZodTypeAny>;

export type JobPayload<T extends JobType = JobType> = z.infer<(typeof JobPayloadSchemas)[T]>;

export function validateJobPayload(type: JobType, payload: unknown) {
  return JobPayloadSchemas[type].parse(payload);
}

export function jobPriority(type: JobType) {
  switch (type) {
    case "webhook_fetch_order":
    case "webhook_fetch_payment":
    case "mini_rest_sweep":
      return 10;
    case "hourly_rest_sweep":
    case "square_sweep":
      return 20;
    case "repair_window":
      return 30;
    case "export_reconcile":
      return 40;
    case "order_detail_hydration":
      return 45;
    case "reconciliation_check":
      return 47;
    case "data_quality_check":
      return 50;
    case "forecast_refresh":
      return 55;
    case "external_recon":
      // Background correctness verification: lower priority than live sync /
      // reconcile, just above the historical backfill so it never blocks them.
      return 58;
    case "historical_export_backfill":
      return 60;
    case "reference_data_refresh":
      return 25;
  }
}
