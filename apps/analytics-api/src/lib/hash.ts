import { createHash } from "node:crypto";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

