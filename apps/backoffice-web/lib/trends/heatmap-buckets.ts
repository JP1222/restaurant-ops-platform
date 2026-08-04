export interface BucketedValue {
  value: number;
  bucket: 0 | 1 | 2 | 3 | 4;
}

function quantile(values: number[], p: number): number {
  const index = Math.min(values.length - 1, Math.floor((values.length - 1) * p));
  return values[index] ?? 0;
}

export function bucketByQuantile(values: number[]): BucketedValue[] {
  if (values.length === 0) return [];

  const positives = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (positives.length === 0) {
    return values.map((value) => ({ value, bucket: 0 }));
  }

  const first = positives[0] ?? 0;
  const last = positives[positives.length - 1] ?? 0;
  if (first === last) {
    return values.map((value) => ({ value, bucket: value <= 0 ? 0 : 2 }));
  }

  const q25 = quantile(positives, 0.25);
  const q50 = quantile(positives, 0.5);
  const q75 = quantile(positives, 0.75);

  return values.map((value) => {
    if (value <= 0) return { value, bucket: 0 };
    if (value <= q25) return { value, bucket: 1 };
    if (value <= q50) return { value, bucket: 2 };
    if (value <= q75) return { value, bucket: 3 };
    return { value, bucket: 4 };
  });
}
