import type { LoginIdentifier } from '@pay2all/validation';

/** Mask an identifier for audit metadata: a***@example.com / +91******3210. */
export function maskIdentifier(identifier: LoginIdentifier): string {
  if (identifier.kind === 'email') {
    const [local = '', domain = ''] = identifier.value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `${identifier.value.slice(0, 3)}******${identifier.value.slice(-4)}`;
}

export function maskEmail(email: string): string {
  return maskIdentifier({ kind: 'email', value: email });
}

export const RATE_LIMITS = {
  loginByIp: { name: 'login:ip', limit: 20, windowSeconds: 300 },
  loginByIdentifier: { name: 'login:id', limit: 10, windowSeconds: 900 },
  mfaByIp: { name: 'mfa:ip', limit: 30, windowSeconds: 300 },
  refreshByIp: { name: 'refresh:ip', limit: 120, windowSeconds: 60 },
  forgotByIp: { name: 'forgot:ip', limit: 20, windowSeconds: 3600 },
  forgotByIdentifier: { name: 'forgot:id', limit: 5, windowSeconds: 3600 },
  resetByIp: { name: 'reset:ip', limit: 20, windowSeconds: 3600 },
} as const;
