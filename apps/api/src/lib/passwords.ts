import argon2 from "argon2";

/** argon2id — resistant to both GPU cracking and side-channel attacks, the recommended default variant. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/**
 * Never throws — a malformed/foreign hash (or any argon2 internal error)
 * is treated as "does not match", not as an exceptional condition the
 * caller has to remember to catch.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
