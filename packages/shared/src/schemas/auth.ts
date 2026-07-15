import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().email().max(320);

// Length-only, no forced complexity rules (uppercase/symbol/etc) —
// current NIST guidance favors length over composition rules, which
// mostly just push users toward predictable substitutions. Max is a
// sanity DoS bound (hashing an arbitrarily large input is wasteful), not
// an argon2 requirement — argon2 doesn't have bcrypt's 72-byte truncation
// quirk.
export const passwordSchema = z.string().min(8, "Password must be at least 8 characters").max(256);

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be lowercase letters, numbers, and hyphens only");

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(200).optional(),
  organizationName: z.string().trim().min(1).max(200),
  // Auto-generated from organizationName if omitted — see apps/api's slugify helper.
  organizationSlug: slugSchema.optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  // No min-length enforced on login — don't leak the signup password
  // policy to someone probing the login endpoint.
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export { slugSchema };
