import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { AppConfig } from "../config.js";

// Object storage for archived receipt images (receipt-archive). Cloudflare R2 is
// S3-compatible, so we use the official AWS SDK v3 client (mature, signs SigV4 for
// us) rather than hand-rolling signed requests — and rather than the host backup's
// rclone CLI, which isn't an app-runtime client. The receive flow archives the
// original invoice image here as BEST-EFFORT: every entry point treats an
// unconfigured / failing R2 as "no image stored", never as a reason to fail a
// receive. Bytes live in R2; only the object key is persisted (inventory_receipt_scans).

export interface ReceiptImage {
  contentType: string;
  data: Buffer;
}

// One client per process, built lazily from config. Returns null when R2 is not
// fully configured, which is how the feature degrades on dev / a fresh install:
// callers see "no R2" and skip archiving without branching on individual env vars.
let cached: { client: S3Client; bucket: string } | null | undefined;

function clientFor(config: AppConfig): { client: S3Client; bucket: string } | null {
  if (cached !== undefined) {
    return cached;
  }
  const { r2Endpoint, r2AccessKeyId, r2SecretAccessKey, r2ReceiptBucket, r2Region } = config;
  if (!r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey || !r2ReceiptBucket) {
    cached = null;
    return cached;
  }
  cached = {
    client: new S3Client({
      region: r2Region,
      endpoint: r2Endpoint,
      credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey }
    }),
    bucket: r2ReceiptBucket
  };
  return cached;
}

export function r2Configured(config: AppConfig): boolean {
  return clientFor(config) !== null;
}

// The R2 object key for a receive's archived image. Derived from the receive's
// idempotency ref (not random) so a retried upload overwrites the SAME object
// instead of leaking a duplicate — the upload is then idempotent, matching the
// receive itself. Namespaced by location so multi-store keys never collide.
export function receiptImageKey(locationId: string, ref: string, contentType: string): string {
  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  return `receipts/${locationId}/${ref}.${ext}`;
}

// Upload the image bytes. Returns true on success, false if R2 is unconfigured.
// THROWS on a real upload error — the caller decides whether that's fatal (it
// isn't: the receive route swallows it to keep archiving best-effort).
export async function putReceiptImage(
  config: AppConfig,
  key: string,
  data: Buffer,
  contentType: string
): Promise<boolean> {
  const c = clientFor(config);
  if (!c) {
    return false;
  }
  await c.client.send(
    new PutObjectCommand({ Bucket: c.bucket, Key: key, Body: data, ContentType: contentType })
  );
  return true;
}

// Fetch image bytes for serving. Returns null when R2 is unconfigured or the
// object is missing (a 404 at the route), so a stale/absent key never 500s.
export async function getReceiptImage(config: AppConfig, key: string): Promise<ReceiptImage | null> {
  const c = clientFor(config);
  if (!c) {
    return null;
  }
  try {
    const res = await c.client.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
    if (!res.Body) {
      return null;
    }
    const bytes = await res.Body.transformToByteArray();
    return { contentType: res.ContentType ?? "application/octet-stream", data: Buffer.from(bytes) };
  } catch {
    // NoSuchKey / NotFound / transient read error — treat as "no image" rather than
    // surfacing a 500; the archive row's existence is the source of truth, the bytes
    // are best-effort.
    return null;
  }
}
