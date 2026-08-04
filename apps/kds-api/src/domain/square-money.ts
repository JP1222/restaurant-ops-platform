// Square `Money.amount` is a **bigint** in the v44 SDK (the #1 migration footgun:
// `JSON.stringify` throws "Do not know how to serialize a BigInt"). Every Square
// money read goes through this ONE coercion so no bigint ever escapes into a
// NormalizedOrder / OrderMenuResponse / DB write. Shared by the catalog and order
// normalizers.
export interface SquareMoneyLike {
  amount?: bigint | number | null;
  currency?: string | null;
}

// Coerce a Square Money amount to integer cents. null / absent / non-finite → 0.
export function squareMoneyToCents(money: SquareMoneyLike | null | undefined): number {
  const amount = money?.amount;
  if (typeof amount === "bigint") {
    return Number(amount);
  }
  if (typeof amount === "number" && Number.isFinite(amount)) {
    return Math.trunc(amount);
  }
  return 0;
}
