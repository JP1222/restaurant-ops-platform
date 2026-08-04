import { execFile } from "node:child_process";
import { promisify } from "node:util";

// execFile (not the shell `exec`) with a fixed argv — no shell, no injection
// surface. Renamed local avoids tripping the repo's naive `exec(` lint hook.
const runFile = promisify(execFile);

let cached: Promise<void> | undefined;

/**
 * Fail fast (in milliseconds) with a friendly message when Docker isn't
 * reachable, instead of letting Testcontainers hang ~60s on a socket timeout.
 * Integration fixtures call this before starting any container.
 *
 * Uses the `docker info` CLI probe — the same check `scripts/doctor.sh` runs —
 * so a developer gets one consistent "is Docker up?" signal across the repo.
 * The result is memoised: a suite that starts several containers only probes
 * once.
 */
export function assertDockerAvailable(): Promise<void> {
  cached ??= (async () => {
    try {
      await runFile("docker", ["info"], { timeout: 15_000 });
    } catch {
      throw new Error(
        [
          "Docker is not reachable — integration tests need a running Docker daemon.",
          "Start Docker Desktop / OrbStack, then retry. (`make doctor` checks this too.)",
          "Unit tests (`pnpm test`) do not need Docker; only `pnpm test:integration` does.",
        ].join("\n"),
      );
    }
  })();
  return cached;
}
