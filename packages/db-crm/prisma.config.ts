// Prisma 7 requires datasource.url in this config file rather than in
// schema.prisma's datasource block. We export a plain object (no
// `defineConfig` import) so the file does not require `prisma/config` to
// be resolvable from CWD — pnpm deploy --prod does not hoist the `prisma`
// package to top-level node_modules/, so resolving `prisma/config` from
// /app/prisma.config.ts in the crm-api runtime image fails. Plain export
// sidesteps that resolution entirely. (Mirrors packages/db-inventory.)
export default {
  datasource: {
    url: process.env.CRM_DATABASE_URL
  }
};
