import { parse as parseCsv } from "csv-parse/sync";
import type { JsonRecord } from "../types.js";

export function parseExportBuffer(buffer: Buffer): JsonRecord[] {
  const text = buffer.toString("utf8").trim();
  if (!text) {
    return [];
  }

  const jsonRows = tryParseJson(text);
  if (jsonRows) {
    return jsonRows;
  }

  const ndjsonRows = tryParseNdjson(text);
  if (ndjsonRows) {
    return ndjsonRows;
  }

  return parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true
  }) as JsonRecord[];
}

function tryParseJson(text: string): JsonRecord[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(isRecord);
    }
    if (isRecord(parsed) && Array.isArray(parsed.elements)) {
      return parsed.elements.filter(isRecord);
    }
    if (isRecord(parsed)) {
      return [parsed];
    }
    return null;
  } catch {
    return null;
  }
}

function tryParseNdjson(text: string): JsonRecord[] | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return null;
  }

  const rows: JsonRecord[] = [];
  try {
    for (const line of lines) {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) {
        rows.push(parsed);
      }
    }
    return rows;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

