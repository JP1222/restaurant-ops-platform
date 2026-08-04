// Types for the zero-build dev-source alias helper (yr-src-map.mjs), so a
// next.config.ts importing it stays fully typed (no implicit any).
export function aliasesForDeps(deps: string[]): Record<string, string>;
export function yrPackagesFor(deps: string[]): string[];
export function yrSrcConfig(appDir: string): {
  aliases: Record<string, string>;
  packages: string[];
};
