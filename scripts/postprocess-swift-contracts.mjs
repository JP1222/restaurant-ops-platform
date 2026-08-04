import { readFile, writeFile } from "node:fs/promises";

const [schemaPath, swiftPath] = process.argv.slice(2);

if (!schemaPath || !swiftPath) {
  console.error("Usage: node scripts/postprocess-swift-contracts.mjs <schema-path> <swift-path>");
  process.exit(1);
}

const schema = JSON.parse(await readFile(schemaPath, "utf8"));
let swiftSource = await readFile(swiftPath, "utf8");

const reservedKeywords = new Set([
  "associatedtype",
  "class",
  "default",
  "deinit",
  "enum",
  "extension",
  "fileprivate",
  "func",
  "import",
  "init",
  "inout",
  "internal",
  "let",
  "operator",
  "private",
  "protocol",
  "public",
  "repeat",
  "static",
  "struct",
  "subscript",
  "switch",
  "typealias",
  "var"
]);

function swiftCaseName(rawValue) {
  const tokens = rawValue
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());

  if (tokens.length === 0) {
    return "value";
  }

  const [first, ...rest] = tokens;
  let candidate = first + rest.map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join("");

  if (/^[0-9]/.test(candidate)) {
    candidate = `value${candidate}`;
  }

  if (reservedKeywords.has(candidate)) {
    return `\`${candidate}\``;
  }

  return candidate;
}

for (const [definitionName, definition] of Object.entries(schema.definitions ?? {})) {
  if (definition?.type !== "string" || !Array.isArray(definition.enum) || definition.enum.length === 0) {
    continue;
  }

  const cases = definition.enum
    .map((rawValue) => `    case ${swiftCaseName(rawValue)} = ${JSON.stringify(rawValue)}`)
    .join("\n");

  const enumPattern = new RegExp(`public enum ${definitionName}: String, Sendable \\{[\\s\\S]*?\\n\\}`, "m");
  if (!enumPattern.test(swiftSource)) {
    continue;
  }

  swiftSource = swiftSource.replace(
    enumPattern,
    `public enum ${definitionName}: String, Sendable {\n${cases}\n}`
  );
}

await writeFile(swiftPath, swiftSource);
