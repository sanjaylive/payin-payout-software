import { describe, expect, it } from 'vitest';
import { createKeyring, FieldEncryptor, safeEqual, sha256Hex } from './crypto';
import { isIdOf, newId } from './ids';
import { checkPasswordPolicy, hashPassword, passwordNeedsRehash, verifyPassword } from './password';
import { PERMISSIONS, type OrgScope } from './permissions';
import { SYSTEM_ROLES } from './roles';
import { generateTotpCode, generateTotpSecret, verifyTotp } from './totp';

describe('password hashing', () => {
  it('hashes with argon2id and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('correct horse');
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password!!')).resolves.toBe(false);
    expect(passwordNeedsRehash(hash)).toBe(false);
  });

  it('returns false (not throw) for malformed hashes', async () => {
    await expect(verifyPassword('not-a-hash', 'x')).resolves.toBe(false);
  });

  it('enforces password policy', () => {
    expect(checkPasswordPolicy('short')).toContain('Must be at least 12 characters');
    expect(checkPasswordPolicy('aman.sharma-2026!', { email: 'aman.sharma@x.com' })).toContain(
      'Must not contain your email name',
    );
    expect(checkPasswordPolicy('pw9876543210xx', { mobile: '+919876543210' })).toContain(
      'Must not contain your mobile number',
    );
    expect(checkPasswordPolicy('A-sufficiently-long-pass')).toEqual([]);
  });
});

describe('FieldEncryptor', () => {
  const key = Buffer.alloc(32, 1).toString('base64');
  const enc = new FieldEncryptor(createKeyring('k1', { k1: key }));

  it('round-trips and produces a versioned envelope with random IVs', () => {
    const a = enc.encrypt('123456789012');
    const b = enc.encrypt('123456789012');
    expect(a).toMatch(/^v1\.k1\./);
    expect(a).not.toEqual(b);
    expect(enc.decrypt(a)).toBe('123456789012');
  });

  it('fails authentication on tampering', () => {
    const env = enc.encrypt('secret');
    const parts = env.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => enc.decrypt(parts.join('.'))).toThrow();
  });

  it('binds ciphertext to associated data', () => {
    const env = enc.encrypt('secret', 'usr_A');
    expect(enc.decrypt(env, 'usr_A')).toBe('secret');
    expect(() => enc.decrypt(env, 'usr_B')).toThrow();
  });

  it('decrypts with old keys after rotation', () => {
    const old = enc.encrypt('legacy');
    const rotated = new FieldEncryptor(
      createKeyring('k2', { k1: key, k2: Buffer.alloc(32, 2).toString('base64') }),
    );
    expect(rotated.decrypt(old)).toBe('legacy');
    expect(rotated.encrypt('new')).toMatch(/^v1\.k2\./);
  });

  it('produces deterministic blind indexes per purpose', () => {
    expect(enc.blindIndex('1234', 'bank')).toBe(enc.blindIndex('1234', 'bank'));
    expect(enc.blindIndex('1234', 'bank')).not.toBe(enc.blindIndex('1234', 'other'));
  });
});

describe('helpers', () => {
  it('safeEqual compares correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('sha256Hex is stable', () => {
    expect(sha256Hex('a')).toHaveLength(64);
  });

  it('generates sortable prefixed ids', () => {
    const a = newId('payment');
    const b = newId('payment');
    expect(isIdOf('payment', a)).toBe(true);
    expect(isIdOf('payout', a)).toBe(false);
    expect(a < b).toBe(true);
  });
});

describe('TOTP', () => {
  it('verifies current codes and blocks replay of the same step', async () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000;
    const code = await generateTotpCode(secret, now);
    const first = await verifyTotp(secret, code, null, now);
    expect(first.valid).toBe(true);
    const replay = await verifyTotp(secret, code, first.timeStep, now);
    expect(replay.valid).toBe(false);
  });

  it('rejects malformed and stale codes', async () => {
    const secret = generateTotpSecret();
    await expect(verifyTotp(secret, 'abcdef')).resolves.toEqual({ valid: false });
    const old = await generateTotpCode(secret, 1_800_000_000);
    await expect(verifyTotp(secret, old, null, 1_800_000_000 + 600)).resolves.toEqual({ valid: false });
  });
});

describe('RBAC catalog', () => {
  it('only grants permissions allowed in each role scope', () => {
    for (const role of SYSTEM_ROLES) {
      for (const perm of role.permissions) {
        const scopes = PERMISSIONS[perm].scopes as readonly OrgScope[];
        expect(scopes, `${role.key} -> ${perm}`).toContain(role.scope);
      }
    }
  });

  it('has unique role keys and no duplicate permissions per role', () => {
    const keys = SYSTEM_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const role of SYSTEM_ROLES) {
      expect(new Set(role.permissions).size, role.key).toBe(role.permissions.length);
    }
  });

  it('requires MFA for every platform role', () => {
    for (const role of SYSTEM_ROLES.filter((r) => r.scope === 'PLATFORM')) {
      expect(role.requiresMfa, role.key).toBe(true);
    }
  });

  it('never gives merchant roles platform-only powers', () => {
    const merchantPerms = SYSTEM_ROLES.filter((r) => r.scope === 'MERCHANT').flatMap((r) => r.permissions);
    for (const p of ['merchant.approve', 'compliance.approve', 'provider.manage', 'ledger.adjust'] as const) {
      expect(merchantPerms).not.toContain(p);
    }
  });
});
