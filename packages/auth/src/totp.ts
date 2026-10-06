import { generate, generateSecret, generateURI, verify } from 'otplib';

/** RFC 6238 defaults compatible with all mainstream authenticator apps. */
const PERIOD_SECONDS = 30;
/** Accept the previous/next 30 s step to tolerate clock drift (docs/SECURITY.md §1.5). */
const EPOCH_TOLERANCE_SECONDS = 30;

export const TOTP_ISSUER = 'Pay2All Payments';

export function generateTotpSecret(): string {
  // 20 bytes (160 bits) base32 — RFC 4226 recommendation.
  return generateSecret({ length: 20 });
}

export function buildTotpUri(secret: string, accountLabel: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: accountLabel, secret });
}

export interface TotpVerification {
  valid: boolean;
  /** Matched time step; persist it and pass it back as `lastUsedStep` to block replays. */
  timeStep?: number;
}

/**
 * Verify a 6-digit TOTP code. Codes from a time step <= `lastUsedStep` are rejected so an observed
 * code cannot be replayed within its validity window.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  lastUsedStep?: number | null,
  nowEpochSeconds?: number,
): Promise<TotpVerification> {
  if (!/^\d{6}$/.test(code)) return { valid: false };
  const result = await verify({
    secret,
    token: code,
    period: PERIOD_SECONDS,
    epochTolerance: EPOCH_TOLERANCE_SECONDS,
    ...(lastUsedStep != null ? { afterTimeStep: lastUsedStep } : {}),
    ...(nowEpochSeconds != null ? { epoch: nowEpochSeconds } : {}),
  });
  if (!result.valid || !('timeStep' in result) || typeof result.timeStep !== 'number') {
    return { valid: false };
  }
  return { valid: true, timeStep: result.timeStep };
}

/** Test/seed helper — generate the current code for a secret. */
export function generateTotpCode(secret: string, nowEpochSeconds?: number): Promise<string> {
  return generate({ secret, period: PERIOD_SECONDS, ...(nowEpochSeconds != null ? { epoch: nowEpochSeconds } : {}) });
}
