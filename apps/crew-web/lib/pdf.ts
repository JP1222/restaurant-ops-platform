"use client";

import type { ResizedImage } from "./image";

// Render the FIRST page of a PDF invoice to a JPEG, so a PDF flows through the
// exact same scan pipeline as a photo (the vision model + backoffice parse only
// accept images). pdfjs-dist is dynamically imported here so it lands in its own
// chunk — the ~PDF renderer only loads when a cook actually picks a PDF, keeping
// the initial Floor bundle lean.

// Invoices have fine print, so render larger than a photo thumbnail (but capped).
const MAX_DIM = 1600;
const JPEG_QUALITY = 0.85;

export async function renderPdfFirstPage(file: File): Promise<ResizedImage> {
  const pdfjs = await import("pdfjs-dist");
  // Same-origin worker bundled by the app (no CDN — keeps `next build` hermetic,
  // matching the vendored fonts). The bundler traces this asset into the build.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_DIM / base.width, MAX_DIM / base.height, 3) || 1;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("canvas unavailable");
    }
    // A PDF page is transparent; JPEG has no alpha, so paint white first or the
    // background renders black and wrecks OCR contrast.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) {
      throw new Error("encode failed");
    }
    return { contentType: "image/jpeg", dataBase64: dataUrl.slice(comma + 1) };
  } finally {
    // Destroy the loading task (tears down the worker + document, freeing memory).
    await loadingTask.destroy();
  }
}
