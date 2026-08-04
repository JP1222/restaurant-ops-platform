import type { Insight } from "@rop/contracts";
import type { HourlyPulse } from "@/lib/analytics-api/hourly-transform";
import type { TodayResponse } from "@/lib/analytics-api/today-shape";

type Rule = (input: { today: TodayResponse; hourly: HourlyPulse | null }) => Insight | null;

const WEEKDAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pct(value: number, fractionDigits = 1): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(fractionDigits)}%`;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const ruleSalesPacing: Rule = ({ today, hourly }) => {
  if (!hourly?.pacing) return null;

  const expectedAtNow = hourly.points[hourly.pacing.current_hour]?.baseline_mean ?? 0;
  if (expectedAtNow <= 0) return null;

  const ratio = hourly.pacing.today_cumulative / expectedAtNow;
  const dayLabel = WEEKDAY_LABEL[today.weekday] ?? "weekday";

  if (ratio < 0.6) {
    return {
      id: "sales-pacing-critical",
      severity: "critical",
      title: `Net sales pacing ${pct((ratio - 1) * 100)} vs ${dayLabel} avg`,
      detail: `By hour ${hourly.pacing.current_hour}:00 you'd typically have ${dollars(expectedAtNow)} but you're at ${dollars(hourly.pacing.today_cumulative)}.`,
      ask_ai_prompt: `Why are net sales pacing so far below the typical ${dayLabel}?`,
      context: {
        ratio,
        expectedAtNow,
        todayCumulative: hourly.pacing.today_cumulative,
        currentHour: hourly.pacing.current_hour,
      },
    };
  }

  if (ratio < 0.8) {
    return {
      id: "sales-pacing-warning",
      severity: "warning",
      title: `Net sales running ${pct((ratio - 1) * 100)} vs ${dayLabel} avg`,
      detail: `${dollars(hourly.pacing.today_cumulative)} so far vs typical ${dollars(expectedAtNow)} by this hour.`,
      ask_ai_prompt: "What might be causing the slow start today?",
      context: { ratio, expectedAtNow, todayCumulative: hourly.pacing.today_cumulative },
    };
  }

  if (ratio > 1.3) {
    return {
      id: "sales-pacing-positive",
      severity: "positive",
      title: `Net sales pacing ${pct((ratio - 1) * 100)} above ${dayLabel} avg`,
      detail: `${dollars(hourly.pacing.today_cumulative)} so far vs typical ${dollars(expectedAtNow)} by this hour.`,
      ask_ai_prompt: "What's driving the strong day so far?",
      context: { ratio, expectedAtNow, todayCumulative: hourly.pacing.today_cumulative },
    };
  }

  return null;
};

const ruleRefundRateElevated: Rule = ({ today }) => {
  const kpi = today.kpis.refund_rate;
  if (kpi.baseline === null || kpi.baseline === 0) return null;
  if (kpi.value < 0.025) return null;

  const multiple = kpi.value / kpi.baseline;
  if (multiple < 1.5) return null;

  return {
    id: "refund-rate-elevated",
    severity: multiple >= 3 ? "critical" : "warning",
    title: `Refund rate ${(kpi.value * 100).toFixed(1)}% - ${multiple.toFixed(1)}x usual`,
    detail: `Today's refund rate is roughly ${multiple.toFixed(1)}x your typical ${(kpi.baseline * 100).toFixed(1)}%. Worth checking which orders or items are driving it.`,
    ask_ai_prompt: "Why is the refund rate elevated today?",
    context: { rate: kpi.value, baseline: kpi.baseline, multiple },
  };
};

const ruleAvgTicketSwing: Rule = ({ today }) => {
  const kpi = today.kpis.avg_ticket;
  if (kpi.wow_pct === null) return null;

  const abs = Math.abs(kpi.wow_pct);
  if (abs < 15) return null;

  const direction = kpi.wow_pct > 0 ? "up" : "down";

  return {
    id: "avg-ticket-swing",
    severity: direction === "up" ? "positive" : "info",
    title: `Avg ticket ${direction} ${pct(kpi.wow_pct)} vs ${WEEKDAY_LABEL[today.weekday] ?? "weekday"} avg`,
    detail: `Today's avg ticket is ${dollars(kpi.value)} vs typical ${dollars(kpi.baseline ?? 0)}.`,
    ask_ai_prompt:
      direction === "up"
        ? "What's driving the higher average ticket today?"
        : "Why is the average ticket lower today? Smaller orders, missing items, discount mix?",
    context: { wow_pct: kpi.wow_pct, value: kpi.value, baseline: kpi.baseline },
  };
};

const ruleOrderVolumeSwing: Rule = ({ today }) => {
  const kpi = today.kpis.orders;
  if (kpi.wow_pct === null) return null;

  const abs = Math.abs(kpi.wow_pct);
  if (abs < 20) return null;

  const direction = kpi.wow_pct > 0 ? "up" : "down";
  const severity: Insight["severity"] =
    direction === "up" ? "positive" : abs > 35 ? "critical" : "warning";

  return {
    id: "order-volume-swing",
    severity,
    title: `Orders ${direction} ${pct(kpi.wow_pct)} vs ${WEEKDAY_LABEL[today.weekday] ?? "weekday"} avg`,
    detail: `${kpi.value} orders so far vs typical ${Math.round(kpi.baseline ?? 0)}.`,
    ask_ai_prompt:
      direction === "up"
        ? "What's driving the higher order count today?"
        : "Why is order volume lower today? Slow channel, weather, day-of-week effect?",
    context: { wow_pct: kpi.wow_pct, value: kpi.value, baseline: kpi.baseline },
  };
};

const RULES: Rule[] = [
  ruleSalesPacing,
  ruleRefundRateElevated,
  ruleAvgTicketSwing,
  ruleOrderVolumeSwing,
];

const SEVERITY_RANK: Record<Insight["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
  positive: 3,
};

export interface RunInsightsInput {
  today: TodayResponse;
  hourly: HourlyPulse | null;
}

export function runInsights(input: RunInsightsInput): Insight[] {
  // Every rule is framed for the live, in-progress day. In recap mode we are
  // showing a closed prior day, so firing them would narrate "today" over stale
  // data (e.g. "44 orders so far") — return nothing and let the recap KPI cards
  // carry the (correctly labeled) comparison.
  if (input.today.mode === "recap") return [];

  const fired: Insight[] = [];

  for (const rule of RULES) {
    try {
      const insight = rule(input);
      if (insight) fired.push(insight);
    } catch (error) {
      console.error("[insights] rule failed:", error);
    }
  }

  return fired.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, 4);
}
