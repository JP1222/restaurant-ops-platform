import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  businessDateAgeDays,
  classifyRecon,
  reconstructControlTotal,
  storeDayWindowUtc
} from "../src/jobs/external-recon.js";

const TZ = "America/Chicago";
const ms = (iso: string) => new Date(iso).getTime();

describe("reconstructControlTotal", () => {
  it("sums successful payments for the business date, skipping failures and other days", () => {
    const payments = [
      { id: "p1", result: "SUCCESS", createdTime: ms("2026-06-08T17:00:00Z"), amount: 799 },
      { id: "p2", result: "SUCCESS", createdTime: ms("2026-06-08T22:30:00Z"), amount: 1200 },
      { id: "p3", result: "FAILED", createdTime: ms("2026-06-08T18:00:00Z"), amount: 5000 },
      { id: "p4", result: "SUCCESS", createdTime: ms("2026-06-09T17:00:00Z"), amount: 4000 }
    ];
    expect(reconstructControlTotal(payments, TZ, "2026-06-08")).toEqual({
      grossCents: 1999,
      txnCount: 2
    });
  });

  it("is zero for a day with no successful payments", () => {
    expect(reconstructControlTotal([], TZ, "2026-06-08")).toEqual({ grossCents: 0, txnCount: 0 });
  });
});

describe("classifyRecon", () => {
  const base = {
    controlGrossCents: 100_000,
    controlTxnCount: 50,
    martGrossCents: 100_000,
    martTxnCount: 50
  };

  it("ok when counts match and cents are within the small band", () => {
    expect(classifyRecon(base).status).toBe("ok");
    expect(classifyRecon({ ...base, controlGrossCents: 100_040 }).status).toBe("ok");
  });

  it("warn when counts match but cents drift past ok into the wider band", () => {
    expect(classifyRecon({ ...base, controlGrossCents: 100_200 }).status).toBe("warn");
  });

  it("fail on a transaction-count mismatch", () => {
    expect(classifyRecon({ ...base, controlTxnCount: 49 }).status).toBe("fail");
  });

  it("fail on a material cents gap even when counts match", () => {
    expect(classifyRecon({ ...base, controlGrossCents: 101_000 }).status).toBe("fail");
  });

  it("source_unavailable when the mart has payments but the re-fetch returned none", () => {
    expect(
      classifyRecon({ controlGrossCents: 0, controlTxnCount: 0, martGrossCents: 100_000, martTxnCount: 50 })
        .status
    ).toBe("source_unavailable");
  });

  it("ok when both sides are empty (no activity to reconcile)", () => {
    expect(
      classifyRecon({ controlGrossCents: 0, controlTxnCount: 0, martGrossCents: 0, martTxnCount: 0 }).status
    ).toBe("ok");
  });

  const empty = { controlGrossCents: 0, controlTxnCount: 0, martGrossCents: 0, martTxnCount: 0 };

  it("confirms closure (ok) for an empty day within the retention horizon", () => {
    expect(classifyRecon({ ...empty, ageDays: 10, retentionDays: 365 }).status).toBe("ok");
    // Boundary: exactly at the horizon is still trustworthy.
    expect(classifyRecon({ ...empty, ageDays: 365, retentionDays: 365 }).status).toBe("ok");
  });

  it("source_unavailable for an empty day older than the retention horizon (cannot confirm closure)", () => {
    // The aging-out trap: a mart-0 day the re-fetch also reports as 0 looks like a
    // closure, but past the horizon the source may have dropped the data. Don't let
    // it de-escalate a possible data loss to a closure.
    expect(classifyRecon({ ...empty, ageDays: 366, retentionDays: 365 }).status).toBe("source_unavailable");
    expect(classifyRecon({ ...empty, ageDays: 5000, retentionDays: 90 }).status).toBe("source_unavailable");
  });

  it("leaves an empty day ok when the age bound is not armed (lifetime-retention source)", () => {
    // Omitting either field (e.g. Clover's effectively-unbounded default) must not
    // flip a real no-activity day to source_unavailable.
    expect(classifyRecon({ ...empty, ageDays: 5000 }).status).toBe("ok");
    expect(classifyRecon({ ...empty, retentionDays: 90 }).status).toBe("ok");
  });

  it("does not age-bound a day the source returned data for (only zero-vs-zero is gated)", () => {
    // controlTxnCount > 0 proves the source still has the day, so age is irrelevant.
    expect(
      classifyRecon({ controlGrossCents: 100_000, controlTxnCount: 50, martGrossCents: 100_000, martTxnCount: 50, ageDays: 5000, retentionDays: 90 }).status
    ).toBe("ok");
  });

  it("reports the signed delta (control minus mart)", () => {
    const verdict = classifyRecon({ ...base, controlGrossCents: 99_000, controlTxnCount: 49 });
    expect(verdict.deltaGrossCents).toBe(-1000);
    expect(verdict.deltaTxnCount).toBe(-1);
  });
});

describe("storeDayWindowUtc", () => {
  it("builds the store-tz day as a half-open UTC window (CDT)", () => {
    const { start, end } = storeDayWindowUtc("2026-06-08", TZ);
    expect(start.toISOString()).toBe("2026-06-08T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-09T05:00:00.000Z");
  });

  it("handles a non-DST winter day (CST, UTC-6)", () => {
    const { start, end } = storeDayWindowUtc("2026-01-15", TZ);
    expect(start.toISOString()).toBe("2026-01-15T06:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-16T06:00:00.000Z");
  });
});

describe("businessDateAgeDays", () => {
  const asOf = DateTime.fromISO("2026-06-17T12:00:00Z");

  it("counts whole store-local days between the business date and today", () => {
    expect(businessDateAgeDays("2026-06-17", TZ, asOf)).toBe(0);
    expect(businessDateAgeDays("2026-06-10", TZ, asOf)).toBe(7);
    expect(businessDateAgeDays("2024-06-17", TZ, asOf)).toBe(730); // 2024 is a leap year
  });

  it("uses the store zone for the day boundary near UTC midnight", () => {
    // 00:30Z on the 17th is still the 16th, 19:30, in America/Chicago — so a
    // business date of the 16th is age 0, not 1, from the store's point of view.
    const justAfterUtcMidnight = DateTime.fromISO("2026-06-17T00:30:00Z");
    expect(businessDateAgeDays("2026-06-16", TZ, justAfterUtcMidnight)).toBe(0);
  });
});
