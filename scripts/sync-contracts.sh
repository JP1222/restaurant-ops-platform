#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/ios/Packages/YRCore/Sources/YRCore/Generated"
OUTPUT_FILE="$OUTPUT_DIR/Contracts.swift"
HELPER_FILE="$OUTPUT_DIR/AnyCodable.swift"
TEMP_DIR="$(mktemp -d)"
SCHEMA_FILE="$TEMP_DIR/contracts.schema.json"
QUICKTYPE_SCHEMA_FILE="$TEMP_DIR/contracts.quicktype.schema.json"
RAW_OUTPUT_FILE="$TEMP_DIR/Contracts.swift"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"

# --check regenerates into a scratch copy and fails if the committed Swift
# contracts are stale, without mutating the working tree (Iron Law #2 for the
# native client — see docs/decisions/0012). Default (no flag) regenerates in place.
CHECK_MODE=0
if [ "${1:-}" = "--check" ]; then
  CHECK_MODE=1
fi

# Prefer the workspace-pinned quicktype (devDependency, exact 23.2.6) so local
# and CI runs generate byte-identical Swift. Fall back to a global install only
# if a contributor has not run pnpm install yet.
if [ -x "$ROOT_DIR/node_modules/.bin/quicktype" ]; then
  QUICKTYPE="$ROOT_DIR/node_modules/.bin/quicktype"
elif command -v quicktype >/dev/null 2>&1; then
  QUICKTYPE="quicktype"
else
  echo "sync-contracts: 'quicktype' not found. Run 'pnpm install' (quicktype is a pinned devDependency)." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

CHECK_BACKUP_DIR="$TEMP_DIR/committed"
if [ "$CHECK_MODE" -eq 1 ]; then
  mkdir -p "$CHECK_BACKUP_DIR"
  if [ -f "$OUTPUT_FILE" ]; then cp "$OUTPUT_FILE" "$CHECK_BACKUP_DIR/Contracts.swift"; fi
  if [ -f "$HELPER_FILE" ]; then cp "$HELPER_FILE" "$CHECK_BACKUP_DIR/AnyCodable.swift"; fi
fi

pnpm --filter @rop/contracts build
node "$ROOT_DIR/scripts/export-contract-schemas.mjs" "$SCHEMA_FILE"
node -e '
const fs = require("fs");
const [inputPath, outputPath] = process.argv.slice(1);
const schema = JSON.parse(fs.readFileSync(inputPath, "utf8"));

// quicktype derives Swift enum-case identifiers from const/enum literals and
// assumes they are strings (it calls String.prototype.codePointAt on the value).
// A boolean or number literal -- e.g. zod z.literal(true) -> { type, const } --
// makes quicktype crash with "s.codePointAt is not a function". A one-case Swift
// enum is not what we want for those anyway, so drop the non-string const/enum and
// let quicktype emit the plain scalar (Bool/Double). Only this quicktype-fed copy
// is altered; the canonical schema keeps the literals for postprocessing.
function sanitizeForQuicktype(node) {
  if (Array.isArray(node)) {
    node.forEach(sanitizeForQuicktype);
    return;
  }
  if (node && typeof node === "object") {
    if ("const" in node && typeof node.const !== "string") {
      if (node.type === undefined && typeof node.const === "boolean") {
        node.type = "boolean";
      } else if (node.type === undefined && typeof node.const === "number") {
        node.type = "number";
      }
      delete node.const;
    }
    if (Array.isArray(node.enum) && node.enum.some((value) => typeof value !== "string")) {
      delete node.enum;
    }
    for (const value of Object.values(node)) {
      sanitizeForQuicktype(value);
    }
  }
}

const definitions = schema.definitions ?? {};
sanitizeForQuicktype(definitions);
const definitionNames = Object.keys(definitions).sort();
const quicktypeSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Root",
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    definitionNames.map((name) => [name, { $ref: `#/definitions/${name}` }])
  ),
  required: definitionNames,
  definitions
};
fs.writeFileSync(outputPath, `${JSON.stringify(quicktypeSchema, null, 2)}\n`);
' "$SCHEMA_FILE" "$QUICKTYPE_SCHEMA_FILE"

"$QUICKTYPE" \
  --lang swift \
  --src-lang schema \
  --src "$QUICKTYPE_SCHEMA_FILE" \
  --top-level Root \
  --access-level public \
  --no-initializers \
  --acronym-style original \
  --density normal \
  --sendable \
  -o "$RAW_OUTPUT_FILE"

perl -0pi -e 's/\/\/ MARK: - Root\npublic struct Root: Codable, Sendable \{[\s\S]*?\n\}\n\n//s' "$RAW_OUTPUT_FILE"
perl -0pi -e 's#//   let root = .*Root.*\n##' "$RAW_OUTPUT_FILE"
perl -0pi -e 's/public (?:final )?class JSONNull: Codable, Hashable(?:, Sendable)? \{[\s\S]*$//s' "$RAW_OUTPUT_FILE"
perl -0pi -e 's/\[String: Any\?\]/[String: AnyCodable]/g; s/\[String: Any\]/[String: AnyCodable]/g' "$RAW_OUTPUT_FILE"
node "$ROOT_DIR/scripts/postprocess-swift-contracts.mjs" "$SCHEMA_FILE" "$RAW_OUTPUT_FILE"

{
  printf '%s\n\n' '// @generated - DO NOT EDIT'
  cat "$RAW_OUTPUT_FILE"
} > "$OUTPUT_FILE"

if grep -Eq '\b(JSONAny|AnyCodable)\b' "$OUTPUT_FILE" && ! grep -Eq '\b(class|struct|enum) (JSONAny|AnyCodable)\b' "$OUTPUT_FILE"; then
  cat > "$HELPER_FILE" <<'EOF'
// @generated - DO NOT EDIT

import Foundation

public final class JSONNull: Codable, Hashable, Sendable {
    public static func == (lhs: JSONNull, rhs: JSONNull) -> Bool {
        true
    }

    public init() {}

    public required init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        guard container.decodeNil() else {
            throw DecodingError.typeMismatch(
                JSONNull.self,
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Expected null value")
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encodeNil()
    }

    public func hash(into hasher: inout Hasher) {}
}

public struct JSONCodingKey: CodingKey, Hashable, Sendable {
    public let stringValue: String
    public let intValue: Int?

    public init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    public init?(intValue: Int) {
        self.stringValue = "\(intValue)"
        self.intValue = intValue
    }
}

// Reason: JSONAny stores heterogenous Foundation values decoded from arbitrary JSON payloads.
public final class JSONAny: Codable, @unchecked Sendable {
    public let value: Any

    public init(_ value: Any) {
        self.value = value
    }

    private static func decodingError(for codingPath: [CodingKey]) -> DecodingError {
        DecodingError.typeMismatch(
            JSONAny.self,
            DecodingError.Context(codingPath: codingPath, debugDescription: "Cannot decode JSONAny")
        )
    }

    private static func encodingError(for value: Any, codingPath: [CodingKey]) -> EncodingError {
        EncodingError.invalidValue(
            value,
            EncodingError.Context(codingPath: codingPath, debugDescription: "Cannot encode JSONAny")
        )
    }

    private static func decode(from container: inout UnkeyedDecodingContainer) throws -> Any {
        if let value = try? container.decode(Bool.self) {
            return value
        }
        if let value = try? container.decode(Int.self) {
            return value
        }
        if let value = try? container.decode(Double.self) {
            return value
        }
        if let value = try? container.decode(String.self) {
            return value
        }
        if let value = try? container.decodeNil(), value {
            return JSONNull()
        }
        if var nestedContainer = try? container.nestedUnkeyedContainer() {
            return try decodeArray(from: &nestedContainer)
        }
        if var nestedContainer = try? container.nestedContainer(keyedBy: JSONCodingKey.self) {
            return try decodeDictionary(from: &nestedContainer)
        }
        throw decodingError(for: container.codingPath)
    }

    private static func decode(from container: inout KeyedDecodingContainer<JSONCodingKey>, forKey key: JSONCodingKey) throws -> Any {
        if let value = try? container.decode(Bool.self, forKey: key) {
            return value
        }
        if let value = try? container.decode(Int.self, forKey: key) {
            return value
        }
        if let value = try? container.decode(Double.self, forKey: key) {
            return value
        }
        if let value = try? container.decode(String.self, forKey: key) {
            return value
        }
        if let value = try? container.decodeNil(forKey: key), value {
            return JSONNull()
        }
        if var nestedContainer = try? container.nestedUnkeyedContainer(forKey: key) {
            return try decodeArray(from: &nestedContainer)
        }
        if var nestedContainer = try? container.nestedContainer(keyedBy: JSONCodingKey.self, forKey: key) {
            return try decodeDictionary(from: &nestedContainer)
        }
        throw decodingError(for: container.codingPath + [key])
    }

    private static func decodeArray(from container: inout UnkeyedDecodingContainer) throws -> [Any] {
        var items: [Any] = []
        while !container.isAtEnd {
            items.append(try decode(from: &container))
        }
        return items
    }

    private static func decodeDictionary(from container: inout KeyedDecodingContainer<JSONCodingKey>) throws -> [String: Any] {
        var dictionary: [String: Any] = [:]
        for key in container.allKeys {
            dictionary[key.stringValue] = try decode(from: &container, forKey: key)
        }
        return dictionary
    }

    private static func encode(to container: inout UnkeyedEncodingContainer, value: Any) throws {
        switch value {
        case let boolValue as Bool:
            try container.encode(boolValue)
        case let intValue as Int:
            try container.encode(intValue)
        case let doubleValue as Double:
            try container.encode(doubleValue)
        case let stringValue as String:
            try container.encode(stringValue)
        case _ as JSONNull:
            try container.encodeNil()
        case let arrayValue as [Any]:
            var nestedContainer = container.nestedUnkeyedContainer()
            try encode(to: &nestedContainer, array: arrayValue)
        case let dictionaryValue as [String: Any]:
            var nestedContainer = container.nestedContainer(keyedBy: JSONCodingKey.self)
            try encode(to: &nestedContainer, dictionary: dictionaryValue)
        default:
            throw encodingError(for: value, codingPath: container.codingPath)
        }
    }

    private static func encode(to container: inout KeyedEncodingContainer<JSONCodingKey>, value: Any, forKey key: JSONCodingKey) throws {
        switch value {
        case let boolValue as Bool:
            try container.encode(boolValue, forKey: key)
        case let intValue as Int:
            try container.encode(intValue, forKey: key)
        case let doubleValue as Double:
            try container.encode(doubleValue, forKey: key)
        case let stringValue as String:
            try container.encode(stringValue, forKey: key)
        case _ as JSONNull:
            try container.encodeNil(forKey: key)
        case let arrayValue as [Any]:
            var nestedContainer = container.nestedUnkeyedContainer(forKey: key)
            try encode(to: &nestedContainer, array: arrayValue)
        case let dictionaryValue as [String: Any]:
            var nestedContainer = container.nestedContainer(keyedBy: JSONCodingKey.self, forKey: key)
            try encode(to: &nestedContainer, dictionary: dictionaryValue)
        default:
            throw encodingError(for: value, codingPath: container.codingPath + [key])
        }
    }

    private static func encode(to container: inout UnkeyedEncodingContainer, array: [Any]) throws {
        for value in array {
            try encode(to: &container, value: value)
        }
    }

    private static func encode(to container: inout KeyedEncodingContainer<JSONCodingKey>, dictionary: [String: Any]) throws {
        for (key, value) in dictionary {
            guard let codingKey = JSONCodingKey(stringValue: key) else {
                continue
            }
            try encode(to: &container, value: value, forKey: codingKey)
        }
    }

    public required init(from decoder: Decoder) throws {
        if var unkeyedContainer = try? decoder.unkeyedContainer() {
            self.value = try Self.decodeArray(from: &unkeyedContainer)
        } else if var keyedContainer = try? decoder.container(keyedBy: JSONCodingKey.self) {
            self.value = try Self.decodeDictionary(from: &keyedContainer)
        } else {
            let container = try decoder.singleValueContainer()
            if let value = try? container.decode(Bool.self) {
                self.value = value
            } else if let value = try? container.decode(Int.self) {
                self.value = value
            } else if let value = try? container.decode(Double.self) {
                self.value = value
            } else if let value = try? container.decode(String.self) {
                self.value = value
            } else if container.decodeNil() {
                self.value = JSONNull()
            } else {
                throw Self.decodingError(for: decoder.codingPath)
            }
        }
    }

    public func encode(to encoder: Encoder) throws {
        if let arrayValue = value as? [Any] {
            var container = encoder.unkeyedContainer()
            try Self.encode(to: &container, array: arrayValue)
        } else if let dictionaryValue = value as? [String: Any] {
            var container = encoder.container(keyedBy: JSONCodingKey.self)
            try Self.encode(to: &container, dictionary: dictionaryValue)
        } else {
            var container = encoder.singleValueContainer()
            switch value {
            case let boolValue as Bool:
                try container.encode(boolValue)
            case let intValue as Int:
                try container.encode(intValue)
            case let doubleValue as Double:
                try container.encode(doubleValue)
            case let stringValue as String:
                try container.encode(stringValue)
            case _ as JSONNull:
                try container.encodeNil()
            default:
                throw Self.encodingError(for: value, codingPath: encoder.codingPath)
            }
        }
    }
}

public typealias AnyCodable = JSONAny
EOF
else
  rm -f "$HELPER_FILE"
fi

if [ "$CHECK_MODE" -eq 1 ]; then
  drift=0
  if ! diff -q "$CHECK_BACKUP_DIR/Contracts.swift" "$OUTPUT_FILE" >/dev/null 2>&1; then
    drift=1
  fi
  if [ -f "$HELPER_FILE" ] || [ -f "$CHECK_BACKUP_DIR/AnyCodable.swift" ]; then
    if ! diff -q "$CHECK_BACKUP_DIR/AnyCodable.swift" "$HELPER_FILE" >/dev/null 2>&1; then
      drift=1
    fi
  fi
  # Restore the committed files — --check must not mutate the working tree.
  if [ -f "$CHECK_BACKUP_DIR/Contracts.swift" ]; then
    cp "$CHECK_BACKUP_DIR/Contracts.swift" "$OUTPUT_FILE"
  fi
  if [ -f "$CHECK_BACKUP_DIR/AnyCodable.swift" ]; then
    cp "$CHECK_BACKUP_DIR/AnyCodable.swift" "$HELPER_FILE"
  else
    rm -f "$HELPER_FILE"
  fi
  if [ "$drift" -ne 0 ]; then
    echo "Swift contracts are stale: packages/contracts changed but ios/.../Generated was not regenerated." >&2
    echo "Fix: run 'pnpm sync-contracts' and commit ios/Packages/YRCore/Sources/YRCore/Generated/." >&2
    exit 1
  fi
  echo "Swift contracts are in sync with packages/contracts."
fi
