import argon2 from 'argon2';

/** OWASP-recommended argon2id baseline (docs/SECURITY.md §1.1). Tunable without breaking old hashes. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** True when a stored hash uses weaker parameters than the current policy and should be upgraded. */
export function passwordNeedsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON2_OPTIONS);
}

/**
 * A real argon2id hash of a random value. Verifying against it when a user does not exist keeps
 * login timing uniform, so attackers can't enumerate accounts by response time.
 */
let dummyHash: Promise<string> | undefined;
export function getDummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(`dummy-${Math.random()}-${Date.now()}`);
  return dummyHash;
}

export interface PasswordPolicyContext {
  email?: string | null;
  mobile?: string | null;
}

/** Returns a list of human-readable violations (empty = acceptable). */
export function checkPasswordPolicy(password: string, ctx: PasswordPolicyContext = {}): string[] {
  const issues: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) issues.push(`Must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH) issues.push(`Must be at most ${PASSWORD_MAX_LENGTH} characters`);
  const lower = password.toLowerCase();
  const local = ctx.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 3 && lower.includes(local)) issues.push('Must not contain your email name');
  const digits = ctx.mobile?.replace(/\D/g, '').slice(-10);
  if (digits && digits.length >= 6 && password.includes(digits)) issues.push('Must not contain your mobile number');
  if (/^(.)\1+$/.test(password)) issues.push('Must not be a single repeated character');
  return issues;
}
