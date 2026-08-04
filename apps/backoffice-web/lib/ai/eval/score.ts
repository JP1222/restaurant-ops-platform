/**
 * Pure scorer for the AI eval (ADR-0030, Phase 0b-3b). Grades a transcript
 * (what tools the model chose + its final text) against a golden case. No I/O,
 * fully deterministic, unit-tested — the runner (./run.ts) supplies transcripts
 * from the live model, but the grading logic lives (and is tested) here.
 */
import { findUnverifiedFigures } from "../numeric-guardrail";
import type { GoldenCase } from "./golden";

export interface ToolCallRecord {
  toolName: string;
  input?: unknown;
}

export interface Transcript {
  toolCalls: ToolCallRecord[];
  /** Tool results this turn — used to grade grounding. */
  toolResults?: unknown;
  finalText: string;
}

export interface CaseScore {
  id: string;
  /** Called the expected tool at least once. */
  toolMatch: boolean;
  /** For get_metric cases: requested the expected metric name (true if N/A). */
  metricMatch: boolean;
  /** No unsourced figures in the answer (true unless the case requires grounding). */
  grounded: boolean;
  pass: boolean;
}

function requestedMetric(input: unknown, name: string): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { name?: unknown }).name === name
  );
}

export function scoreCase(testCase: GoldenCase, transcript: Transcript): CaseScore {
  const toolMatch = transcript.toolCalls.some((tc) => tc.toolName === testCase.expectTool);

  let metricMatch = true;
  if (testCase.expectMetric) {
    metricMatch = transcript.toolCalls.some(
      (tc) => tc.toolName === "get_metric" && requestedMetric(tc.input, testCase.expectMetric!),
    );
  }

  let grounded = true;
  if (testCase.mustBeGrounded) {
    grounded = findUnverifiedFigures(transcript.finalText, transcript.toolResults).length === 0;
  }

  return {
    id: testCase.id,
    toolMatch,
    metricMatch,
    grounded,
    pass: toolMatch && metricMatch && grounded,
  };
}

export interface Scorecard {
  total: number;
  passed: number;
  passRate: number;
  cases: CaseScore[];
}

export function scoreAll(
  cases: GoldenCase[],
  transcripts: Map<string, Transcript>,
): Scorecard {
  const scored = cases.map((testCase): CaseScore => {
    const transcript = transcripts.get(testCase.id);
    if (!transcript) {
      return { id: testCase.id, toolMatch: false, metricMatch: false, grounded: false, pass: false };
    }
    return scoreCase(testCase, transcript);
  });
  const passed = scored.filter((s) => s.pass).length;
  return {
    total: scored.length,
    passed,
    passRate: scored.length ? passed / scored.length : 0,
    cases: scored,
  };
}
