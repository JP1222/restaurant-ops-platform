"use client";

import type { SettingSource } from "@rop/contracts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CommitField } from "../commit-field";
import { Segmented } from "../segmented";
import { SettingRow, type SettingRowAudit } from "../setting-row";
import { useMockSettings } from "./use-mock-settings";

const SEED = {
  "ws.name": "Example Kitchen",
  "ws.tz": "America/New_York",
  "ws.lang": "English (US)",
  "ws.landing": "Today",
  "ws.week": "Mon",
};

const SEED_SOURCE: Record<string, SettingSource> = {
  "ws.name": "db",
  "ws.tz": "db",
  "ws.lang": "default",
  "ws.landing": "db",
  "ws.week": "default",
};

const SEED_AUDIT: Record<string, SettingRowAudit> = {
  "ws.name": { when: "3 weeks ago", by: "Maya Chen" },
  "ws.tz": { when: "3 weeks ago", by: "Maya Chen" },
  "ws.landing": { when: "6 days ago", by: "Devon Brooks" },
};

const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
const LANGUAGES = ["English (US)", "Español", "中文 (简体)", "Français"];
const LANDINGS = ["Hub", "Today", "Trends", "Inventory"];

export function GeneralPanel() {
  const { values, update, status, sourceFor, auditFor } = useMockSettings(SEED, SEED_SOURCE, SEED_AUDIT);
  const rowProps = (key: string) => ({ source: sourceFor(key), status: status(key), meta: auditFor(key) });

  return (
    <div className="rounded-xl border bg-card px-6 shadow-sm">
      <SettingRow
        label="Workspace name"
        description="Shown across the backoffice and on printed tickets."
        htmlFor="ws-name"
        {...rowProps("ws.name")}
      >
        <CommitField id="ws-name" value={values["ws.name"] ?? ""} onCommit={(v) => update("ws.name", v)} />
      </SettingRow>

      <SettingRow
        label="Time zone"
        description="Used for reporting boundaries and the daily reset."
        htmlFor="ws-tz"
        {...rowProps("ws.tz")}
      >
        <Select value={values["ws.tz"]} onValueChange={(v) => update("ws.tz", v)}>
          <SelectTrigger id="ws-tz" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz} value={tz}>
                {tz}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow
        label="Language"
        description="Interface language for this operator account."
        htmlFor="ws-lang"
        {...rowProps("ws.lang")}
      >
        <Select value={values["ws.lang"]} onValueChange={(v) => update("ws.lang", v)}>
          <SelectTrigger id="ws-lang" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((lang) => (
              <SelectItem key={lang} value={lang}>
                {lang}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow
        label="Default landing page"
        description="Where you land after signing in."
        htmlFor="ws-landing"
        {...rowProps("ws.landing")}
      >
        <Select value={values["ws.landing"]} onValueChange={(v) => update("ws.landing", v)}>
          <SelectTrigger id="ws-landing" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANDINGS.map((page) => (
              <SelectItem key={page} value={page}>
                {page}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow
        label="Week starts on"
        description="First day of the week in analytics charts."
        {...rowProps("ws.week")}
      >
        <Segmented
          aria-label="Week starts on"
          value={values["ws.week"] ?? "Mon"}
          onValueChange={(v) => update("ws.week", v)}
          options={[
            { value: "Sun", label: "Sun" },
            { value: "Mon", label: "Mon" },
          ]}
        />
      </SettingRow>
    </div>
  );
}
