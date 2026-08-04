// Pure slug helpers for store creation. Deliberately Prisma-free so they unit-test
// without the db-kds client; `db.ts` composes them with a uniqueness query.

/** Lowercase kebab-case a store name; falls back to "store" when empty after cleanup. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "store"
  );
}

/**
 * The first slug in the `base, base-2, base-3, …` series not already in `taken`.
 * `Location.slug` is unique, so two stores named "Anytown" must not collide.
 */
export function nextAvailableSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  let candidate = `${base}-${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}
