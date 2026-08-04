import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ViewSnapshot {
  view?: string;
  url?: string;
  data?: unknown;
  capturedAt?: string;
}

interface BuildSystemPromptArgs {
  viewSnapshot?: ViewSnapshot | null;
  systemPromptAppend?: string | null;
}

// The base prompt lives in `prompts/system.md` (plain markdown, no template) so
// it is diff-friendly and editable without touching code (issue #226). The
// AppSetting `ai.system_prompt_append` adds operator notes on top at request
// time. The route runs on the Node runtime (`runtime = "nodejs"`), so `fs` is
// available.
//
// Read is lazy + memoized rather than at module load: Turbopack rewrites
// `__dirname` to a virtual chunk path that the asset is NOT copied next to, so
// a module-load read crashes `next build`'s "Collecting page data" phase
// (which evaluates modules but never calls this function). Resolving on first
// `buildSystemPrompt` call defers the read to a context where the real file
// path is resolvable, across dev / vitest / standalone runtime.
const PROMPT_RELATIVE_PATH = join("lib", "ai", "prompts", "system.md");

function resolvePromptPath(): string {
  // Candidate roots, in order of specificity:
  //  - __dirname/prompts/system.md  -> vitest + webpack (real source dir)
  //  - <cwd>/lib/ai/prompts/...      -> `next build` (cwd = app dir)
  //  - <cwd>/apps/backoffice-web/... -> standalone runtime (cwd = monorepo root,
  //    file copied via outputFileTracingIncludes)
  const fallback = join(__dirname, "prompts", "system.md");
  const candidates = [
    fallback,
    join(process.cwd(), PROMPT_RELATIVE_PATH),
    join(process.cwd(), "apps", "backoffice-web", PROMPT_RELATIVE_PATH),
  ];
  return candidates.find((path) => existsSync(path)) ?? fallback;
}

// Memoized for the process lifetime. Editing prompts/system.md therefore does
// NOT take effect until the server process restarts (the file is read once, here).
let cachedBaseSystem: string | null = null;

function getBaseSystem(): string {
  if (cachedBaseSystem === null) {
    cachedBaseSystem = readFileSync(resolvePromptPath(), "utf8").trimEnd();
  }
  return cachedBaseSystem;
}

const SNAPSHOT_MAX_CHARS = 2048;

/**
 * Render the view snapshot inside a fenced code block whose backtick run is
 * guaranteed longer than any backtick run in the payload. CommonMark only
 * closes a fenced block with a fence of *at least* as many backticks, so a
 * snapshot containing a literal ``` can never terminate the fence early
 * (issue #219). The snapshot is BFF-shaped today, but a future tool's
 * structured output could carry backticks — this keeps the block balanced
 * without mutating the data.
 */
function fencedSnapshot(snap: string): string {
  let longestRun = 0;
  let current = 0;
  for (const char of snap) {
    if (char === "`") {
      current += 1;
      if (current > longestRun) longestRun = current;
    } else {
      current = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}json\n${snap}\n${fence}`;
}

export function buildSystemPrompt({
  viewSnapshot,
  systemPromptAppend,
}: BuildSystemPromptArgs): string {
  // Operator-defined text from `ai.system_prompt_append` (AppSetting). Trim to
  // drop whitespace-only values cleanly; empty -> no-op (no trailing blank
  // separator polluting the prompt).
  const baseSystem = getBaseSystem();
  const appendTrimmed = systemPromptAppend?.trim() ?? "";
  const withAppend = appendTrimmed ? `${baseSystem}\n\n${appendTrimmed}` : baseSystem;
  if (!viewSnapshot) return withAppend;
  const snap = JSON.stringify(viewSnapshot).slice(0, SNAPSHOT_MAX_CHARS);
  return `${withAppend}\n\n## Current view context\n${fencedSnapshot(snap)}\n`;
}
