// Notification domain model. One record drives both surfaces (bell + inbox) and
// the AI investigation, per the design handoff. The shape mirrors what a future
// events/notifications service would return; today it is seeded from sample-data.

export type Severity = "crit" | "warn" | "info";

export type Category = "sales" | "inv" | "dev" | "cost" | "intg";

export type NotificationGroup = "Today" | "Yesterday" | "Earlier this week";

/** Deep-link target for a row's primary action ("View in Trends", etc.). */
export interface NotificationAction {
  label: string;
  /** lucide icon name (kebab-case); resolved via lib/notifications/icons. */
  icon: string;
  href: string;
}

export interface Notification {
  id: string;
  severity: Severity;
  category: Category;
  categoryLabel: string;
  /** lucide icon name (kebab-case). */
  icon: string;
  title: string;
  detail: string;
  createdAt: string;
  /** Derived from createdAt at seed time (see derive.ts). */
  group: NotificationGroup;
  /** Relative label ("8m", "1h", "Yesterday", "Mon") derived from createdAt. */
  timeLabel: string;
  read: boolean;
  /** If set and in the future, hidden from both surfaces. */
  snoozedUntil?: string | null;
  /** If set, hidden everywhere (archived). */
  dismissedAt?: string | null;
  action: NotificationAction;
  /** AI investigation payload — lazy in production, inlined in sample data. */
  ai?: AiInvestigation;
}

// ---- AI investigation ------------------------------------------------------

export interface AiInvestigation {
  /** Always present; the "traceable" explanation. */
  text: string;
  /** Optional — present only when a component adds value. */
  block?: AiBlock;
}

export type BlockTone = Severity | "neutral" | "accent";

export interface BarsBlock {
  kind: "bars";
  label: "Chart";
  title: string;
  caption: string;
  cols: { label: string; value: string; ratio: number; emphasis?: boolean }[];
}

export interface CompareBlock {
  kind: "compare";
  label: "Comparison";
  title: string;
  caption: string;
  rows: { label: string; value: string; ratio: number; tone: BlockTone }[];
}

export interface StepsBlock {
  kind: "steps";
  label: "Options";
  title: string;
  items: { text: string }[];
}

export interface MetricBlock {
  kind: "metric";
  label: "Headline";
  value: string;
  unit: string;
  metricLabel: string;
  delta: string;
  deltaTone: "up" | "down";
}

export interface ActionBlock {
  kind: "action";
  label: "Suggested action";
  /** lucide icon name (kebab-case). */
  icon: string;
  title: string;
  hint: string;
  action: SuggestedAction;
}

export type AiBlock = BarsBlock | CompareBlock | StepsBlock | MetricBlock | ActionBlock;

/**
 * Mutating suggested action. Applied via a two-step confirm — never a single
 * click. The confirm is meant to be idempotent, manager-gated, and audit-logged
 * on the server; this UI only drives the idle → confirming → applied states.
 */
export interface SuggestedAction {
  id: string;
  applyLabel: string;
  confirmPrompt: string;
  doneLabel: string;
  endpoint: string;
  idempotencyKey: string;
}

// ---- Preferences -----------------------------------------------------------

export type NotificationChannel = "inapp" | "email" | "push";

/** Minimum severity that reaches a channel: all severities / warning & up / critical only. */
export type MinSeverity = "all" | "warn" | "crit";

export interface CategoryPref {
  label: string;
  /** lucide icon name (kebab-case). */
  icon: string;
  inapp: boolean;
  email: boolean;
  push: boolean;
  sev: MinSeverity;
}

export interface NotificationPrefs {
  quiet: boolean;
  quietFrom: string;
  quietTo: string;
  cats: Record<Category, CategoryPref>;
}
