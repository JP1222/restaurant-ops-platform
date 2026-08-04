import { z } from "zod";

// Phase-3 DTOs live HERE (not packages/contracts) on purpose: no cross-app
// consumer calls crm-api yet (order-web / backoffice integration is Phase 6),
// so these shapes have not crossed an app boundary. They migrate to
// packages/contracts/src/loyalty.ts when the first consumer lands — the same
// "prototype DTOs migrate to contracts when the boundary is crossed" rule
// ADR-0025 sets for order-web. Iron Law #2 is honoured at that point.

export const EnrollRequestSchema = z.object({
  phone: z.string().min(1),
  displayName: z.string().trim().max(120).optional(),
  email: z.string().email().optional(),
  birthMonth: z.number().int().min(1).max(12).optional(),
  marketingSmsConsent: z.boolean().optional()
});
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;

export interface CustomerSummary {
  phone_e164: string;
  display_name: string | null;
  birth_month: number | null;
  marketing_sms_consent: boolean;
  enrolled_at: string;
}

export interface BalanceResponse {
  phone_e164: string;
  balance_points: number;
  pending_points: number;
  lifetime_earned: number;
  lifetime_redeemed: number;
  lifetime_eligible_spend_cents: number;
  last_activity_at: string | null;
}

export interface HistoryEntry {
  type: string;
  points: number;
  status: string;
  source: string;
  occurred_at: string;
}

export interface HistoryResponse {
  phone_e164: string;
  entries: HistoryEntry[];
}

export interface RewardCatalogEntry {
  slug: string;
  label: string;
  cost_points: number;
  kind: string;
  value_cents: number;
}

export interface RewardCatalogResponse {
  rewards: RewardCatalogEntry[];
}
