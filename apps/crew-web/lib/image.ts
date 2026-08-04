"use client";

// Shrink a chosen photo to a small JPEG before upload. A modern phone camera
// produces 8–12MP images (several MB); the API caps a photo at ~2MB binary, and a
// thumbnail in a kitchen picker doesn't need more than ~1024px. Resizing client-side
// keeps the base64 payload small and the upload fast on shop wifi. Returns bare
// base64 (no `data:` prefix) plus the content type.

export interface ResizedImage {
  contentType: string;
  dataBase64: string;
}

const MAX_DIM = 1024;
const JPEG_QUALITY = 0.82;

export async function resizeImageForUpload(file: File): Promise<ResizedImage> {
  const source = await loadSource(file);
  const sw = "naturalWidth" in source ? source.naturalWidth : source.width;
  const sh = "naturalHeight" in source ? source.naturalHeight : source.height;
  const { width, height } = fit(sw, sh, MAX_DIM);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("canvas unavailable");
  }
  ctx.drawImage(source, 0, 0, width, height);
  if ("close" in source) {
    source.close();
  }

  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new Error("encode failed");
  }
  return { contentType: "image/jpeg", dataBase64: dataUrl.slice(comma + 1) };
}

// Prefer createImageBitmap (respects EXIF orientation, decodes off the main
// thread); fall back to an <img> when it's unavailable.
async function loadSource(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // fall through to the <img> path
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

function fit(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) {
    return { width: w, height: h };
  }
  const scale = Math.min(max / w, max / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}
