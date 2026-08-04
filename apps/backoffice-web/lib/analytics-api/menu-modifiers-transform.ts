import type { ItemModifierRow } from "./types";

export interface MenuModifier {
  modifier_name: string;
  modifier_count: number;
  modifier_total_cents: number;
  attach_rate: number;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function transformMenuModifiers(rows: ItemModifierRow[]): MenuModifier[] {
  return rows
    .map((row) => ({
      modifier_name: row.modifier_name,
      modifier_count: toNumber(row.modifier_count),
      modifier_total_cents: toNumber(row.modifier_total_cents),
      attach_rate: toNumber(row.attach_rate)
    }))
    .sort((a, b) => {
      if (b.attach_rate !== a.attach_rate) return b.attach_rate - a.attach_rate;
      if (b.modifier_count !== a.modifier_count) return b.modifier_count - a.modifier_count;
      return a.modifier_name.localeCompare(b.modifier_name);
    });
}
