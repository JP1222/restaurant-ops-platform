import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";

describe("buildSystemPrompt", () => {
  test("with no append or snapshot -> returns the base prompt verbatim", () => {
    const base = buildSystemPrompt({});
    expect(base).toContain("Example Kitchen restaurant analytics assistant");
    expect(base).not.toContain("## Current view context");
    // No trailing blank separator from an empty append.
    expect(base.endsWith("\n\n")).toBe(false);
  });

  test("base prompt routes authoritative numbers through get_metric (tiered routing)", () => {
    const base = buildSystemPrompt({});
    expect(base).toContain("## Grounding numbers");
    expect(base).toContain("get_metric");
    expect(base).toContain("list_metrics");
    expect(base.toLowerCase()).toContain("never use raw sql for a headline number");
  });

  test("with append set -> concatenates after base with a blank-line separator", () => {
    const out = buildSystemPrompt({ systemPromptAppend: "foo" });
    const base = buildSystemPrompt({});
    expect(out).toBe(`${base}\n\nfoo`);
  });

  test("with whitespace-only append -> treated as empty (no separator added)", () => {
    const base = buildSystemPrompt({});
    expect(buildSystemPrompt({ systemPromptAppend: "" })).toBe(base);
    expect(buildSystemPrompt({ systemPromptAppend: "   \n\t  " })).toBe(base);
    expect(buildSystemPrompt({ systemPromptAppend: null })).toBe(base);
    expect(buildSystemPrompt({ systemPromptAppend: undefined })).toBe(base);
  });

  test("append is trimmed before insertion (no leading/trailing whitespace bleed)", () => {
    const out = buildSystemPrompt({ systemPromptAppend: "  hello world  \n" });
    expect(out.endsWith("\n\nhello world")).toBe(true);
  });

  test("append is placed before the view-snapshot block when both are present", () => {
    const out = buildSystemPrompt({
      systemPromptAppend: "extra ops context",
      viewSnapshot: { view: "dashboard", url: "/dashboard" },
    });
    const appendIdx = out.indexOf("extra ops context");
    const snapIdx = out.indexOf("## Current view context");
    expect(appendIdx).toBeGreaterThan(0);
    expect(snapIdx).toBeGreaterThan(appendIdx);
  });

  test("view snapshot only -> append section omitted but snapshot rendered", () => {
    const out = buildSystemPrompt({ viewSnapshot: { view: "trends" } });
    expect(out).toContain("## Current view context");
    expect(out).toContain('"view":"trends"');
  });
});
