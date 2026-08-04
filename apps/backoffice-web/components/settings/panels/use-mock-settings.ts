"use client";

import { useCallback, useRef, useState } from "react";
import type { SettingSource } from "@rop/contracts";
import type { SettingRowAudit } from "../setting-row";
import type { SaveStatus } from "../status-pill";

const SAVE_LATENCY_MS = 500;
const SAVED_CLEAR_MS = 1_900;

type StringMap = Record<string, string>;

/**
 * Local stand-in for useSettingsSave, used by the scaffold panels (General,
 * Profile) whose keys have no backend yet. It reproduces the real save
 * lifecycle — optimistic value, saving→saved pill, source flips to "db", audit
 * line becomes "just now · you" — entirely in component state. Swap for the real
 * hook once these keys are registered in packages/contracts.
 */
export function useMockSettings(
  seed: StringMap,
  seedSource: Record<string, SettingSource>,
  seedAudit: Record<string, SettingRowAudit>
) {
  const [values, setValues] = useState<StringMap>(seed);
  const [sources, setSources] = useState<Record<string, SettingSource>>(seedSource);
  const [audit, setAudit] = useState<Record<string, SettingRowAudit>>(seedAudit);
  const [statusMap, setStatusMap] = useState<Record<string, SaveStatus>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const update = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setStatusMap((prev) => ({ ...prev, [key]: "saving" }));
    clearTimeout(timers.current[`save_${key}`]);
    timers.current[`save_${key}`] = setTimeout(() => {
      setSources((prev) => ({ ...prev, [key]: "db" }));
      setAudit((prev) => ({ ...prev, [key]: { when: "just now", by: "you" } }));
      setStatusMap((prev) => ({ ...prev, [key]: "saved" }));
      clearTimeout(timers.current[`clear_${key}`]);
      timers.current[`clear_${key}`] = setTimeout(() => {
        setStatusMap((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }, SAVED_CLEAR_MS);
    }, SAVE_LATENCY_MS);
  }, []);

  const status = useCallback((key: string): SaveStatus | null => statusMap[key] ?? null, [statusMap]);
  const sourceFor = useCallback((key: string): SettingSource => sources[key] ?? "default", [sources]);
  const auditFor = useCallback(
    (key: string): SettingRowAudit | null => (sources[key] === "db" ? (audit[key] ?? null) : null),
    [sources, audit]
  );

  return { values, update, status, sourceFor, auditFor };
}
