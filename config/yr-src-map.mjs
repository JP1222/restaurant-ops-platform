import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for "dev resolves package SOURCE, not stale dist".
//
// Zero-build on purpose: a plain .mjs (no tsc step) so a Next config can import
// it on a cold clone, before any package's dist/ exists. Repo root is derived
// from this file's own location (config/yr-src-map.mjs -> ../).
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// "@rop/db-kds" -> <root>/packages/db-kds. The directory name is the
// package name minus the @rop scope, a convention every package holds.
function pkgDir(spec) {
  return path.join(ROOT, "packages", spec.replace(/^@rop\//, ""));
}

// Every export subpath of `spec` that declares a `yr-src` condition, as
// { spec: <full import specifier>, abs: <absolute src path> }. The alias map is
// DERIVED from each package's own exports map, so the exports map stays the one
// source of truth — there is no parallel hand-maintained list to drift.
function yrSubpaths(spec) {
  const pkgJson = path.join(pkgDir(spec), "package.json");
  if (!existsSync(pkgJson)) return [];
  const { exports = {} } = JSON.parse(readFileSync(pkgJson, "utf8"));
  const out = [];
  for (const [sub, conditions] of Object.entries(exports)) {
    const src =
      conditions && typeof conditions === "object" ? conditions["yr-src"] : undefined;
    if (!src) continue;
    const full = sub === "." ? spec : `${spec}/${sub.replace(/^\.\//, "")}`;
    out.push({ spec: full, abs: path.join(pkgDir(spec), src) });
  }
  return out;
}

const yrDeps = (deps) => deps.filter((d) => d.startsWith("@rop/"));

// Dev-only specifier -> src alias map for Turbopack `resolveAlias`. Returns {}
// unless YR_SRC=1, so `next build` / `next start` / tests / prod — none of which
// set the flag — keep resolving the `import` condition (dist/*.js). This is the
// frontend twin of the backends' NODE_OPTIONS='--conditions=yr-src'.
export function aliasesForDeps(deps) {
  if (process.env.YR_SRC !== "1") return {};
  const out = {};
  for (const dep of yrDeps(deps)) {
    for (const { spec, abs } of yrSubpaths(dep)) {
      // Fail loud under the dev gate: a wrong/renamed src path must error here,
      // never silently emit a missing alias that falls back to stale dist.
      if (!existsSync(abs)) {
        throw new Error(`[yr-src] alias target missing: ${abs} (for ${spec})`);
      }
      // Turbopack resolveAlias rejects absolute (`/...`) values as "server
      // relative imports"; give it a path relative to the monorepo root (its
      // auto-detected resolve root via pnpm-lock.yaml).
      out[spec] = "./" + path.relative(ROOT, abs).split(path.sep).join("/");
    }
  }
  return out;
}

// The @rop/* deps that ship a yr-src target, for Next `transpilePackages`
// so it compiles the raw TS the alias resolves to. Not YR_SRC-gated: harmless in
// prod (resolved dist is already JS) and mirrors what kds-web/crew-web do today.
export function yrPackagesFor(deps) {
  return yrDeps(deps).filter((dep) => yrSubpaths(dep).length > 0);
}

function depsOf(appDir) {
  const { dependencies = {} } = JSON.parse(
    readFileSync(path.join(appDir, "package.json"), "utf8"),
  );
  return Object.keys(dependencies);
}

// One call for a Next app's next.config: derives both the resolveAlias map and
// the transpilePackages additions from the app's OWN declared dependencies, so
// every frontend is wired identically and a new app gets correct wiring for free.
export function yrSrcConfig(appDir) {
  const deps = depsOf(appDir);
  return { aliases: aliasesForDeps(deps), packages: yrPackagesFor(deps) };
}
