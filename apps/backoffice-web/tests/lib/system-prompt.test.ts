import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";

/**
 * Snapshot-fence safety for `buildSystemPrompt` (issue #219).
 *
 * The view snapshot is JSON.stringify'd, sliced to 2048 chars, and embedded in
 * a fenced code block. A naive ```-fence breaks if the payload itself contains
 * a ``` run (possible from a future tool's structured output). These cover the
 * three acceptance cases: no snapshot, oversize snapshot, and backtick payload.
 */

const FENCE_MAX_CHARS = 2048;

/** Count the longest run of consecutive backticks anywhere in `s`. */
function longestBacktickRun(s: string): number {
  const runs = s.match(/`+/g);
  return runs ? Math.max(...runs.map((r) => r.length)) : 0;
}

describe("buildSystemPrompt — snapshot fence", () => {
  test("no snapshot -> BASE_SYSTEM only, no view-context block", () => {
    const out = buildSystemPrompt({ viewSnapshot: null });
    expect(out).toContain("Example Kitchen restaurant analytics assistant");
    expect(out).not.toContain("## Current view context");
    // The base prompt itself may contain fenced examples (e.g. the ```mermaid
    // diagram instruction), so assert specifically that no view-context snapshot
    // fence (```json) was appended — that's the property this case guards.
    expect(out).not.toContain("```json");
  });

  test("oversize snapshot -> serialized payload is truncated to the cap", () => {
    const huge = "x".repeat(10_000);
    const out = buildSystemPrompt({ viewSnapshot: { view: huge } });
    expect(out).toContain("## Current view context");

    // The embedded JSON between the fences must be <= the cap. Extract it.
    const fenceMatch = out.match(/```+json\n([\s\S]*?)\n```+/);
    expect(fenceMatch).not.toBeNull();
    const payload = fenceMatch?.[1] ?? "";
    expect(payload.length).toBeLessThanOrEqual(FENCE_MAX_CHARS);
    // Truncation actually happened (full serialization would far exceed the cap).
    expect(payload.length).toBeLessThan(JSON.stringify({ view: huge }).length);
  });

  test("snapshot containing a ``` run -> opening fence is longer than the run", () => {
    // A literal triple-backtick inside the data would close a naive ```-fence.
    const out = buildSystemPrompt({
      viewSnapshot: { view: "trends", data: "evil ``` close ```` me" },
    });

    const openMatch = out.match(/\n(`+)json\n/);
    expect(openMatch).not.toBeNull();
    const openFenceLen = openMatch?.[1]?.length ?? 0;

    // CommonMark only closes a fenced block with a fence of >= the opening
    // length; the opener must therefore exceed the longest inner run so the
    // payload can never terminate the block early.
    const innerRun = longestBacktickRun('{"view":"trends","data":"evil ``` close ```` me"}');
    expect(openFenceLen).toBeGreaterThan(innerRun);
    expect(openFenceLen).toBeGreaterThanOrEqual(3);
  });

  test("ordinary snapshot still uses a standard triple-backtick fence", () => {
    const out = buildSystemPrompt({ viewSnapshot: { view: "dashboard" } });
    expect(out).toContain("```json\n");
    expect(out).toContain('"view":"dashboard"');
  });
});
