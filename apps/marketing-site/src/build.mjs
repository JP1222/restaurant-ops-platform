import { readdir, mkdir, copyFile, rm, stat, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, extname } from "node:path";

// Zero-dependency build: stage src/{index.html,styles.css,script.js,
// sitemap.xml,robots.txt,public/**} into dist/. The marketing site has no
// markdown to render and no template expansion — index.html is hand-written.
// This script exists so the runtime container has a self-contained dist/ to
// serve, mirroring the apps/legal-site shape so the Dockerfile/nginx pipeline
// reads the same on both apps.

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const srcDir = here;
const distDir = join(appRoot, "dist");

const TOP_LEVEL_FILES = ["index.html", "styles.css", "script.js", "sitemap.xml", "robots.txt"];
const ASSET_DIRS = ["public"];

// Tiny regex-based CSS minifier (no deps): strip /* */ comments and collapse
// runs of whitespace. styles.css has no `content: "/*..."` strings and no
// url() literals, so neither pass can mis-match (issue #214). Re-verify those
// assumptions if you ever add string content or data-URIs to the CSS.
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")        // drop comments
    .replace(/\s+/g, " ")                      // collapse whitespace
    .replace(/\s*([{}:;,>])\s*/g, "$1")       // trim around separators
    .replace(/;}/g, "}")                        // drop last semicolon in a block
    .trim();
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function copyTree(srcPath, distPath) {
  const entries = await readdir(srcPath, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(srcPath, entry.name);
    const to = join(distPath, entry.name);
    if (entry.isDirectory()) {
      await ensureDir(to);
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    }
  }
}

await rm(distDir, { recursive: true, force: true });
await ensureDir(distDir);

for (const file of TOP_LEVEL_FILES) {
  const from = join(srcDir, file);
  const to = join(distDir, file);
  if (extname(file) === ".css") {
    const raw = await readFile(from, "utf8");
    await writeFile(to, minifyCss(raw));
  } else {
    await copyFile(from, to);
  }
}

for (const dir of ASSET_DIRS) {
  const from = join(srcDir, dir);
  const to = join(distDir, dir);
  try {
    const s = await stat(from);
    if (s.isDirectory()) {
      await ensureDir(to);
      await copyTree(from, to);
    }
  } catch {
    // dir doesn't exist — skip silently. Lets us delete public/ during dev
    // without the build exploding.
  }
}

const tree = [];
async function walk(p) {
  const entries = await readdir(p, { withFileTypes: true });
  for (const e of entries) {
    const full = join(p, e.name);
    if (e.isDirectory()) await walk(full);
    else tree.push(relative(distDir, full));
  }
}
await walk(distDir);

console.log(`Built apps/marketing-site/dist (${tree.length} files):`);
for (const f of tree.sort()) console.log(`  ${f}`);
