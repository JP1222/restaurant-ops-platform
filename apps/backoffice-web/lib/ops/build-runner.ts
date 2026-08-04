import {
  buildRunnerMachineKeys,
  type BuildRunnerMachine,
  type BuildRunnerMachineKey,
  type BuildRunnerStrategy,
} from "@rop/contracts";

// Encode/decode the `BUILD_RUNNER` repo variable. Shared by the BFF route
// (app/api/ops/build-runner) and the Build routing card so both agree on the
// wire format:
//   balanced → "mac-mini,macbook"   (comma = any-free pool)
//   priority → "macbook>mac-mini"   (">" = try left-to-right, first free wins)

export const MACHINE_LABELS: Record<BuildRunnerMachineKey, string> = {
  "mac-mini": "Mac Mini",
  macbook: "MacBook",
};

const VALID_KEYS = new Set<string>(buildRunnerMachineKeys);
function isMachineKey(value: string): value is BuildRunnerMachineKey {
  return VALID_KEYS.has(value);
}

export function parseBuildRunner(value: string): {
  strategy: BuildRunnerStrategy;
  machines: BuildRunnerMachine[];
} {
  const trimmed = value.trim();
  if (trimmed === "") {
    // Unset variable → default: every machine eligible, any-free.
    return {
      strategy: "balanced",
      machines: buildRunnerMachineKeys.map((key) => ({ key, enabled: true })),
    };
  }
  const priority = trimmed.includes(">");
  const tokens = trimmed
    .split(priority ? ">" : ",")
    .map((token) => token.trim())
    .filter(isMachineKey);
  const enabled = tokens.filter((token, i) => tokens.indexOf(token) === i);
  const enabledSet = new Set<BuildRunnerMachineKey>(enabled);

  // Priority preserves the encoded order (it IS the rank), then appends any
  // disabled machines in canonical order. Balanced is always canonical order.
  const machines: BuildRunnerMachine[] = priority
    ? [
        ...enabled.map((key) => ({ key, enabled: true })),
        ...buildRunnerMachineKeys
          .filter((key) => !enabledSet.has(key))
          .map((key) => ({ key, enabled: false })),
      ]
    : buildRunnerMachineKeys.map((key) => ({ key, enabled: enabledSet.has(key) }));

  return { strategy: priority ? "priority" : "balanced", machines };
}

export function serializeBuildRunner(
  strategy: BuildRunnerStrategy,
  machines: readonly BuildRunnerMachine[],
): string {
  const enabled = machines.filter((m) => m.enabled).map((m) => m.key);
  if (enabled.length === 0) return "";
  return strategy === "priority" ? enabled.join(">") : enabled.join(",");
}

export function buildRunnerSummary(
  strategy: BuildRunnerStrategy,
  machines: readonly BuildRunnerMachine[],
): string {
  const enabled = machines.filter((m) => m.enabled);
  if (enabled.length === 0) return "no runner selected";
  const labels = enabled.map((m) => MACHINE_LABELS[m.key]);
  if (enabled.length === buildRunnerMachineKeys.length && strategy === "balanced") {
    return "Any free Mac";
  }
  if (strategy === "priority") return labels.join(" → ");
  return `${labels.join(" · ")} · any free`;
}
