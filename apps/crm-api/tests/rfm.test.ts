import { describe, expect, it } from "vitest";
import { loyaltySegmentKeys } from "@rop/contracts";
import {
  computeRfmCohorts,
  quintileScores,
  segmentFor,
  type MemberFacts
} from "../src/domain/rfm.js";

describe("quintileScores", () => {
  it("ranks ascending into 1..5 with 5 = top fifth", () => {
    // 10 values, 2 per quintile.
    expect(quintileScores([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4, 5, 5
    ]);
  });

  it("preserves the original input order (rank-based, top value scores 5)", () => {
    // n=3: ceil((pos+1)*5/3) over the ascending ranks → 2, 4, 5; mapped back to
    // input order [100, 10, 50] = [5, 2, 4]. Small samples skew toward the top end.
    expect(quintileScores([100, 10, 50])).toEqual([5, 2, 4]);
  });

  it("degrades gracefully below 5 values", () => {
    expect(quintileScores([42])).toEqual([5]);
    expect(quintileScores([])).toEqual([]);
  });
});

describe("segmentFor", () => {
  it("maps each (r,f,m) to exactly one segment", () => {
    expect(segmentFor(5, 5, 5)).toBe("champions");
    expect(segmentFor(3, 5, 2)).toBe("loyal"); // frequent + still around, lower spend
    expect(segmentFor(1, 3, 2)).toBe("at_risk"); // was frequent, gone quiet
    expect(segmentFor(2, 1, 5)).toBe("at_risk"); // high value, gone quiet
    expect(segmentFor(1, 1, 1)).toBe("hibernating");
    expect(segmentFor(4, 2, 2)).toBe("potential_loyalist"); // recent, building
    expect(segmentFor(3, 1, 1)).toBe("needs_attention"); // recent-ish, low engagement
  });

  it("never returns a key outside the contract enum", () => {
    for (let r = 1; r <= 5; r += 1) {
      for (let f = 1; f <= 5; f += 1) {
        for (let m = 1; m <= 5; m += 1) {
          expect(loyaltySegmentKeys).toContain(segmentFor(r, f, m));
        }
      }
    }
  });
});

describe("computeRfmCohorts", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  const members: MemberFacts[] = [
    { monetaryCents: 50_000, frequency: 20, lastActivityAt: daysAgo(2) }, // champion-ish
    { monetaryCents: 30_000, frequency: 12, lastActivityAt: daysAgo(10) },
    { monetaryCents: 8_000, frequency: 3, lastActivityAt: daysAgo(40) },
    { monetaryCents: 12_000, frequency: 5, lastActivityAt: daysAgo(120) }, // at risk
    { monetaryCents: 2_000, frequency: 1, lastActivityAt: daysAgo(5) }, // new
    { monetaryCents: 1_000, frequency: 1, lastActivityAt: daysAgo(300) }, // hibernating
    { monetaryCents: 0, frequency: 0, lastActivityAt: null } // enrolled, never purchased
  ];

  it("counts total vs active and excludes never-purchased from the RFM base", () => {
    const result = computeRfmCohorts(members, now);
    expect(result.total_members).toBe(7);
    expect(result.active_members).toBe(6); // the frequency-0 / null member is excluded
  });

  it("always returns all six segments and conserves member counts + spend", () => {
    const result = computeRfmCohorts(members, now);
    expect(result.segments.map((s) => s.key).sort()).toEqual([...loyaltySegmentKeys].sort());

    const segMembers = result.segments.reduce((sum, s) => sum + s.member_count, 0);
    expect(segMembers).toBe(result.active_members);

    const segSpend = result.segments.reduce((sum, s) => sum + s.total_spend_cents, 0);
    const activeSpend = members
      .filter((m) => m.frequency >= 1 && m.lastActivityAt !== null)
      .reduce((sum, m) => sum + m.monetaryCents, 0);
    expect(segSpend).toBe(activeSpend);

    const totalPct = result.segments.reduce((sum, s) => sum + s.pct_of_active, 0);
    expect(totalPct).toBeCloseTo(1, 6);
  });

  it("splits new (one order) vs returning (two or more), conserving the active base", () => {
    const result = computeRfmCohorts(members, now);
    expect(result.new_vs_returning.new_count).toBe(2); // the two frequency-1 members
    expect(result.new_vs_returning.returning_count).toBe(4);
    expect(result.new_vs_returning.new_count + result.new_vs_returning.returning_count).toBe(
      result.active_members
    );
  });

  it("handles an empty base without dividing by zero", () => {
    const result = computeRfmCohorts([], now);
    expect(result.active_members).toBe(0);
    expect(result.segments.every((s) => s.member_count === 0 && s.pct_of_active === 0)).toBe(true);
    expect(result.segments.every((s) => s.avg_recency_days === null)).toBe(true);
  });
});
