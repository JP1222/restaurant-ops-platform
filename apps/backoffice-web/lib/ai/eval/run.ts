/**
 * Manual, OFFLINE eval runner (ADR-0030, Phase 0b-3b). Drives the live model
 * over the golden questions and prints a metric-selection scorecard.
 *
 * NOT run in CI — it calls the real model (non-deterministic) and needs a key:
 *
 *   DEEPSEEK_API_KEY=sk-... [AI_EVAL_MODEL=deepseek-v4-pro] \
 *     pnpm --filter @rop/backoffice-web exec tsx lib/ai/eval/run.ts
 *
 * It builds "inert" tools (same schema + description as the real ones, but no
 * `execute`), so the SDK returns which tool + metric the model CHOOSES for each
 * question without running the backend. That isolates routing/selection — the
 * behavior the system prompt, tool descriptions, and list_metrics affect — from
 * data correctness (which the resolveMetric integration tests already cover).
 */
import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText, type ToolSet } from "ai";

import { buildSystemPrompt } from "../system-prompt";
import { aiTools } from "../tools";
import { GOLDEN_CASES } from "./golden";
import { scoreAll, type Transcript } from "./score";

function inertToolset(): ToolSet {
  // Keep description + inputSchema, drop `execute`, so the model's chosen tool
  // calls come back unrun — no backend needed to measure routing. The assertion
  // is contained to this offline dev tool.
  const inert: Record<string, { description?: string; inputSchema: unknown }> = {};
  for (const [name, definition] of Object.entries(aiTools)) {
    inert[name] = { description: definition.description, inputSchema: definition.inputSchema };
  }
  return inert as unknown as ToolSet;
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is required to run the AI eval (offline tool).");
  }
  const modelId = process.env.AI_EVAL_MODEL ?? "deepseek-chat";
  const provider = createDeepSeek({ apiKey });
  const system = buildSystemPrompt({});
  const tools = inertToolset();

  const transcripts = new Map<string, Transcript>();
  for (const testCase of GOLDEN_CASES) {
    const result = await generateText({
      model: provider.chat(modelId),
      tools,
      system,
      messages: [{ role: "user", content: testCase.question }],
    });
    transcripts.set(testCase.id, {
      toolCalls: result.toolCalls.map((tc) => ({ toolName: tc.toolName, input: tc.input })),
      finalText: result.text,
    });
  }

  const card = scoreAll(GOLDEN_CASES, transcripts);
  for (const c of card.cases) {
    process.stdout.write(
      `${c.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(20)} tool=${c.toolMatch} metric=${c.metricMatch} grounded=${c.grounded}\n`,
    );
  }
  process.stdout.write(
    `\n${card.passed}/${card.total} passed (${Math.round(card.passRate * 100)}%)\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
