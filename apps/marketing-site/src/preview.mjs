import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname } from "node:path";

// Tiny dev server for the built dist/ directory. Run after `pnpm build`.
// Doesn't watch / rebuild — re-run `pnpm build && pnpm preview` after edits.

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const distDir = join(appRoot, "dist");
const PORT = Number(process.env.PORT ?? 8081);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function resolveFile(reqPath) {
  // Map clean URLs the same way nginx.conf does: /foo -> /foo, /foo.html, /foo/index.html.
  const cleaned = reqPath.split("?")[0].split("#")[0];
  const candidates = [
    cleaned,
    cleaned + ".html",
    join(cleaned, "index.html"),
  ];
  for (const c of candidates) {
    const full = join(distDir, c);
    if (!full.startsWith(distDir)) continue; // path traversal guard
    try {
      const s = await stat(full);
      if (s.isFile()) return full;
    } catch {
      // not found — try next candidate
    }
  }
  return null;
}

createServer(async (req, res) => {
  try {
    const target = req.url === "/" ? "/index.html" : req.url;
    const file = await resolveFile(target);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    const body = await readFile(file);
    const mime = MIME[extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": mime });
    res.end(body);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("500 Internal Server Error");
  }
}).listen(PORT, () => {
  console.log(`Preview: http://localhost:${PORT}/  (serving ${distDir})`);
});
