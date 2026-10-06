import { describe, expect, it } from 'vitest';
import { createUserSchema, identifierSchema, loginFormSchema, loginSchema, normalizeMobile } from './index';

describe('identifier normalisation', () => {
  it('normalises emails and Indian mobiles', () => {
    expect(identifierSchema.parse('  Aman@Example.COM ')).toEqual({ kind: 'email', value: 'aman@example.com' });
    expect(identifierSchema.parse('98765 43210')).toEqual({ kind: 'mobile', value: '+919876543210' });
    expect(identifierSchema.parse('+91-9876543210')).toEqual({ kind: 'mobile', value: '+919876543210' });
    expect(normalizeMobile('1234567890')).toBeNull();
  });

  it('rejects garbage', () => {
    expect(identifierSchema.safeParse('not-an-id').success).toBe(false);
    expect(identifierSchema.safeParse('a@b').success).toBe(false);
  });
});

describe('strict objects', () => {
  it('rejects unknown keys (tenant ids cannot be smuggled into bodies)', () => {
    const r = loginSchema.safeParse({ identifier: 'a@b.com', password: 'x', organization_id: 'org_x' });
    expect(r.success).toBe(false);
  });

  it('validates role keys', () => {
    expect(
      createUserSchema.safeParse({ name: 'Aman', email: 'a@b.com', role_key: 'merchant_owner' }).success,
    ).toBe(false);
  });
});

describe('form schemas', () => {
  it('validate like the API schema but keep the raw identifier string', () => {
    expect(loginFormSchema.parse({ identifier: ' 98765 43210 ', password: 'x' }).identifier).toBe('98765 43210');
    expect(loginFormSchema.safeParse({ identifier: 'nope', password: 'x' }).success).toBe(false);
  });
});
