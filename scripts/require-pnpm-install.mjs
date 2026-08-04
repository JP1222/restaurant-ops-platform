#!/usr/bin/env node

const userAgent = process.env.npm_config_user_agent ?? "";

if (userAgent.startsWith("pnpm/")) {
  process.exit(0);
}

const detectedManager = userAgent.split(" ")[0] || "unknown";

console.error(
  [
    "Example Kitchen uses pnpm for dependency installs.",
    `Detected package manager: ${detectedManager}`,
    "Run: corepack enable && corepack prepare pnpm@10.33.0 --activate",
    "Then run: pnpm install",
  ].join("\n"),
);

process.exit(1);
