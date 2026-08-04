import {
  loyaltySegmentKeys,
  type LoyaltyCohort,
  type LoyaltyCohortsResponse,
  type LoyaltySegmentKey
} from "@rop/contracts";

/**
 * Pure RFM cohort engine (no I/O). The route fetches per-member facts from the
 * loyalty data and hands them here; this assigns quintile scores + a segment and
 * rolls everything up to PII-free aggregates (counts + cents only).
 *
 * Lifetime RFM: Recency = days since the member's last eligible order, Frequency
 * = count of eligible orders, Monetary = lifetime eligible spend (cents). Only
 * members with at least one eligible order are scored (the "active" base); the
 * enrolled-but-never-purchased remainder is reported as total − active.
 */
export interface MemberFacts {
  /** Lifetime eligible spend, integer cents. */
  monetaryCents: number;
  /** Count of eligible (earning) orders. */
  frequency: number;
  /** Timestamp of the last eligible order, or null if the member never purchased. */
  lastActivityAt: Date | null;
}

const MS_PER_DAY = 86_400_000;

/**
 * Quintile (ntile-5) score in 1..5 for each value by ascending rank — 5 = top
 * fifth. n<5 degrades gracefully (a single member scores 5). Returns scores in
 * the original input order.
 */
export function quintileScores(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const scores = new Array<number>(n);
  order.forEach((entry, pos) => {
    scores[entry.i] = Math.min(5, Math.max(1, Math.ceil(((pos + 1) * 5) / n)));
  });
  return scores;
}

/**
 * Map RFM quintile scores (each 1..5) to exactly one segment. Priority-ordered so
 * every (r,f,m) lands in one bucket; a high-value-but-inactive member is "at risk"
 * (worth winning back), not lumped with the low-value "hibernating" set.
 */
export function segmentFor(r: number, f: number, m: number): LoyaltySegmentKey {
  if (r >= 4 && f >= 4 && m >= 4) return "champions";
  if (f >= 4 && r >= 3) return "loyal";
  if (r <= 2 && (f >= 3 || m >= 4)) return "at_risk";
  if (r <= 2) return "hibernating";
  if (r >= 3 && f >= 2) return "potential_loyalist";
  return "needs_attention";
}

export function computeRfmCohorts(members: MemberFacts[], now: Date): LoyaltyCohortsResponse {
  const active = members.filter((m) => m.frequency >= 1 && m.lastActivityAt !== null);

  const recencyDays = active.map((m) =>
    Math.max(0, Math.floor((now.getTime() - (m.lastActivityAt as Date).getTime()) / MS_PER_DAY))
  );
  // Recency scores invert days (fewer days since last order = better), so negate
  // before ranking and reuse the single ascending-rank quintile helper.
  const rScores = quintileScores(recencyDays.map((d) => -d));
  const fScores = quintileScores(active.map((m) => m.frequency));
  const mScores = quintileScores(active.map((m) => m.monetaryCents));

  const empty = () => ({ member_count: 0, total_spend_cents: 0, recency_sum: 0 });
  const acc: Record<LoyaltySegmentKey, { member_count: number; total_spend_cents: number; recency_sum: number }> =
    Object.fromEntries(loyaltySegmentKeys.map((k) => [k, empty()])) as Record<
      LoyaltySegmentKey,
      { member_count: number; total_spend_cents: number; recency_sum: number }
    >;

  let newCount = 0;
  let newSpend = 0;
  let returningCount = 0;
  let returningSpend = 0;

  active.forEach((member, i) => {
    // Parallel arrays are all length `active.length`; the `??` defaults never fire
    // and only satisfy noUncheckedIndexedAccess.
    const key = segmentFor(rScores[i] ?? 1, fScores[i] ?? 1, mScores[i] ?? 1);
    const bucket = acc[key];
    bucket.member_count += 1;
    bucket.total_spend_cents += member.monetaryCents;
    bucket.recency_sum += recencyDays[i] ?? 0;

    if (member.frequency >= 2) {
      returningCount += 1;
      returningSpend += member.monetaryCents;
    } else {
      newCount += 1;
      newSpend += member.monetaryCents;
    }
  });

  const activeCount = active.length;
  const segments: LoyaltyCohort[] = loyaltySegmentKeys.map((key) => {
    const b = acc[key];
    return {
      key,
      member_count: b.member_count,
      total_spend_cents: b.total_spend_cents,
      avg_recency_days: b.member_count > 0 ? b.recency_sum / b.member_count : null,
      pct_of_active: activeCount > 0 ? b.member_count / activeCount : 0
    };
  });

  return {
    as_of: now.toISOString(),
    total_members: members.length,
    active_members: activeCount,
    segments,
    new_vs_returning: {
      new_count: newCount,
      new_spend_cents: newSpend,
      returning_count: returningCount,
      returning_spend_cents: returningSpend
    }
  };
}
