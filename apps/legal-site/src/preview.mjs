import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", "dist");
const port = Number(process.env.PORT ?? 8080);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

async function fileExists(path) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function resolveRequestPath(urlPath) {
  if (urlPath === "/" || urlPath === "") return join(distDir, "index.html");
  const direct = join(distDir, urlPath.replace(/^\//, ""));
  if (await fileExists(direct)) return direct;
  const htmlVariant = `${direct}.html`;
  if (await fileExists(htmlVariant)) return htmlVariant;
  const indexVariant = join(direct, "index.html");
  if (await fileExists(indexVariant)) return indexVariant;
  return null;
}

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const resolved = await resolveRequestPath(urlPath);
  if (!resolved) {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Not found");
    return;
  }
  const contents = await readFile(resolved);
  res.statusCode = 200;
  res.setHeader("content-type", mime[extname(resolved)] ?? "application/octet-stream");
  res.end(contents);
});

server.listen(port, () => {
  console.log(`Preview ready at http://localhost:${port}/`);
  console.log("  /         landing");
  console.log("  /eula     End User License Agreement");
  console.log("  /privacy  Privacy Policy");
});
