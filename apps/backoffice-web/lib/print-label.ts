import JsBarcode from "jsbarcode";

// Code128 label rendering + print for internal house codes (barcode-onboarding ADR, D4). The
// barcode is generated client-side (JsBarcode -> canvas) and printed via a hidden iframe with a
// CSS @page sized for a Dymo label — no server round-trip, no data egress. Only imported by the
// client-only PrintLabelDialog.

// Dymo 30334 multipurpose (2.25in x 1.25in). Change these two values for a different label stock.
const LABEL_WIDTH = "2.25in";
const LABEL_HEIGHT = "1.25in";

export function renderBarcodeDataUrl(code: string): string {
  const canvas = document.createElement("canvas");
  JsBarcode(canvas, code, {
    format: "CODE128",
    displayValue: true,
    fontSize: 16,
    height: 48,
    margin: 6
  });
  return canvas.toDataURL("image/png");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
  );
}

export function printLabel(code: string, itemName: string): void {
  const dataUrl = renderBarcodeDataUrl(code);
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  const name = itemName.length > 28 ? `${itemName.slice(0, 27)}…` : itemName;
  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
      `@page{size:${LABEL_WIDTH} ${LABEL_HEIGHT};margin:0.08in}` +
      `html,body{margin:0;padding:0;font-family:sans-serif;text-align:center}` +
      `img{max-width:100%;height:auto}.n{font-size:9pt;margin-top:2px}` +
      `</style></head><body>` +
      `<img src="${dataUrl}" alt="${escapeHtml(code)}"><div class="n">${escapeHtml(name)}</div>` +
      `</body></html>`
  );
  doc.close();
  win.focus();
  // Let the data-URL image paint before printing, then tear the frame down.
  window.setTimeout(() => {
    win.print();
    window.setTimeout(() => frame.remove(), 1000);
  }, 250);
}
