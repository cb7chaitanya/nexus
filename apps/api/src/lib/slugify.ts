import { randomBytes } from "node:crypto";

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

  return slug || "org";
}

const MAX_ATTEMPTS = 10;

/**
 * Generates a slug from `base`, retrying with a random suffix on
 * collision. `isTaken` is expected to check uniqueness against the DB.
 */
export async function generateUniqueSlug(
  base: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const root = slugify(base);

  if (!(await isTaken(root))) {
    return root;
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = `${root}-${randomBytes(3).toString("hex")}`;
    if (!(await isTaken(candidate))) {
      return candidate;
    }
  }

  throw new Error(`Could not generate a unique slug for "${base}" after ${MAX_ATTEMPTS} attempts`);
}
