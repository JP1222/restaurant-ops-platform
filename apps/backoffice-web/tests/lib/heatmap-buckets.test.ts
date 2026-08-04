import { describe, expect, test } from "vitest";
import { bucketByQuantile } from "@/lib/trends/heatmap-buckets";

describe("bucketByQuantile", () => {
  test("empty input returns an empty array", () => {
    expect(bucketByQuantile([])).toEqual([]);
  });

  test("all zero values are bucket 0", () => {
    expect(bucketByQuantile([0, 0, 0])).toEqual([
      { value: 0, bucket: 0 },
      { value: 0, bucket: 0 },
      { value: 0, bucket: 0 },
    ]);
  });

  test("all equal positive values are bucket 2", () => {
    expect(bucketByQuantile([100, 100, 100, 100])).toEqual([
      { value: 100, bucket: 2 },
      { value: 100, bucket: 2 },
      { value: 100, bucket: 2 },
      { value: 100, bucket: 2 },
    ]);
  });

  test("monotonically increasing values produce increasing buckets", () => {
    const result = bucketByQuantile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);

    expect(result[0]!.bucket).toBeLessThanOrEqual(result[9]!.bucket);
    expect(result[0]!.bucket).toBe(1);
    expect(result[9]!.bucket).toBe(4);
  });

  test("zero values stay bucket 0 alongside positives", () => {
    const result = bucketByQuantile([0, 10, 20, 30, 40]);

    expect(result[0]).toEqual({ value: 0, bucket: 0 });
    expect(result.slice(1).every((item) => item.bucket >= 1)).toBe(true);
  });

  test("a record outlier does not flatten normal positive days to bucket 0", () => {
    const values = Array.from({ length: 99 }, () => 100);
    values.push(100_000);

    const result = bucketByQuantile(values);

    expect(result[result.length - 1]!.bucket).toBe(4);
    expect(result.slice(0, 99).every((item) => item.bucket > 0)).toBe(true);
  });
});
