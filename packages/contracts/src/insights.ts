/**
 * "Today" insights contract.
 *
 * `apps/backoffice-web/app/api/today/insights` runs a set of rule functions over
 * the day's analytics and emits a small list of operator-facing insight cards
 * (sales pacing, refund-rate spikes, ticket / volume swings). Today only the same
 * app's components read it, but the moment a native client or an AI tool reads
 * `/api/today/insights` the shape would have to be reverse-engineered — so it
 * moves here per the ADR-0025 prototype-DTO rule (audit #200).
 *
 * `context` is a free-form `record(string, unknown)` bag the rules attach for the
 * "Ask AI" follow-up (ratios, baselines, the figures behind the headline). It is
 * intentionally untyped — it's diagnostic context for the model, not a stable
 * field-by-field contract.
 */
import { z } from "zod";

export const insightSeverities = ["critical", "warning", "info", "positive"] as const;
export const InsightSeveritySchema = z.enum(insightSeverities);
export type InsightSeverity = z.infer<typeof InsightSeveritySchema>;

export const InsightSchema = z.object({
  id: z.string(),
  severity: InsightSeveritySchema,
  title: z.string(),
  detail: z.string(),
  ask_ai_prompt: z.string(),
  // Free-form diagnostic context surfaced to the AI follow-up; not a stable
  // field contract (e.g. { ratio, baseline, expectedAtNow }).
  context: z.record(z.string(), z.unknown()).optional(),
});
export type Insight = z.infer<typeof InsightSchema>;

export const InsightsResponseSchema = z.object({
  insights: z.array(InsightSchema),
  all_clear: z.boolean(),
});
export type InsightsResponse = z.infer<typeof InsightsResponseSchema>;
