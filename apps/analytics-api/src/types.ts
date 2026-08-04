export type JsonRecord = Record<string, unknown>;

export type CloverExportType = "ORDERS" | "PAYMENTS";

export type TenderType = "CASH" | "CREDIT_CARD" | "GIFT_CARD" | "OTHER" | "UNKNOWN";

export type TimeWindow = {
  start: Date;
  end: Date;
};

export type LocalTimeParts = {
  businessDate: string;
  localHour: number;
  weekday: number;
  yearMonth: string;
  isoWeek: number;
};

