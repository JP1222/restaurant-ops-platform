import { describe, expect, it } from "vitest";
import { validateAiSql } from "../src/analytics/safe-query.js";

describe("AI SQL guard", () => {
  it("allows read-only mart queries", () => {
    expect(validateAiSql("select * from mart.sales_daily_mv limit 10")).toEqual({ ok: true });
  });

  it("allows CTE read-only queries", () => {
    expect(validateAiSql("with x as (select * from mart.fact_orders) select count(*) from x")).toEqual({ ok: true });
  });

  it("rejects writes", () => {
    expect(validateAiSql("delete from mart.fact_orders")).toMatchObject({ ok: false });
  });

  it("rejects raw schema access", () => {
    expect(validateAiSql("select * from raw.clover_orders")).toMatchObject({ ok: false });
  });

  it("rejects multi-statement SQL", () => {
    expect(validateAiSql("select 1; select 2")).toMatchObject({ ok: false });
  });
});

