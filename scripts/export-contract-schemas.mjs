import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const schemaOutputPath = process.argv[2];

if (!schemaOutputPath) {
  console.error("Usage: node scripts/export-contract-schemas.mjs <output-path>");
  process.exit(1);
}

const contractsModule = await import(path.join(rootDir, "packages/contracts/dist/index.js"));

function stripSchemaSuffix(name) {
  return name.endsWith("Schema") ? name.slice(0, -"Schema".length) : name;
}

function rewriteRefs(node) {
  if (Array.isArray(node)) {
    return node.map(rewriteRefs);
  }

  if (node && typeof node === "object") {
    const out = {};

    for (const [key, value] of Object.entries(node)) {
      if (value === undefined) {
        continue;
      }

      if (key === "$ref" && typeof value === "string" && value.startsWith("#/definitions/")) {
        const oldName = value.slice("#/definitions/".length);
        out[key] = `#/definitions/${stripSchemaSuffix(oldName)}`;
      } else {
        const rewrittenValue = rewriteRefs(value);
        if (rewrittenValue !== undefined) {
          out[key] = rewrittenValue;
        }
      }
    }

    return out;
  }

  return node;
}

function stableStringify(node) {
  if (Array.isArray(node)) {
    return `[${node.map(stableStringify).join(",")}]`;
  }

  if (node && typeof node === "object") {
    return `{${Object.keys(node)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(node[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(node);
}

function dedupeDefinitions(definitions) {
  const signatures = Object.entries(definitions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => [name, stableStringify(definition)]);

  function visit(node, currentName, isTopLevel = false) {
    if (Array.isArray(node)) {
      return node.map((value) => visit(value, currentName));
    }

    if (node && typeof node === "object") {
      if (!isTopLevel && !("$ref" in node)) {
        const signature = stableStringify(node);
        const match = signatures.find(([name, candidate]) => name !== currentName && candidate === signature);

        if (match) {
          return { $ref: `#/definitions/${match[0]}` };
        }
      }

      const out = {};
      for (const [key, value] of Object.entries(node)) {
        out[key] = visit(value, currentName);
      }
      return out;
    }

    return node;
  }

  const deduped = {};
  for (const [name, definition] of Object.entries(definitions)) {
    deduped[name] = visit(definition, name, true);
  }

  return deduped;
}

const schemaEntries = Object.entries(contractsModule)
  .filter(([name, value]) => name.endsWith("Schema") && typeof value?.safeParse === "function")
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, schema]) => {
    const contractName = stripSchemaSuffix(name);
    const jsonSchema = schema.toJSONSchema({ target: "draft-07" });
    return { contractName, jsonSchema };
  });

const definitions = {};

for (const { contractName, jsonSchema } of schemaEntries) {
  const localDefinitions = jsonSchema.definitions ?? {};
  for (const [key, value] of Object.entries(localDefinitions)) {
    definitions[stripSchemaSuffix(key)] = value;
  }

  if (!definitions[contractName] && jsonSchema.$ref !== `#/definitions/${contractName}`) {
    definitions[contractName] = {
      ...jsonSchema,
      $schema: undefined,
      definitions: undefined
    };
  }
}

const rewrittenDefinitions = rewriteRefs(definitions);

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  definitions: dedupeDefinitions(rewrittenDefinitions)
};

await writeFile(schemaOutputPath, `${JSON.stringify(schema, null, 2)}\n`);
