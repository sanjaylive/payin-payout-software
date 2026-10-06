import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildLoggerOptions } from './logger';
import { redact, REDACTED } from './redaction';

describe('redact', () => {
  it('redacts sensitive keys at any depth, case-insensitively', () => {
    const out = redact({
      user: { email: 'a@b.com', Password: 'hunter2' },
      beneficiary: { account_number: '123456789012', ifsc: 'HDFC0001234' },
      list: [{ refreshToken: 'x' }],
    });
    expect(out.user.Password).toBe(REDACTED);
    expect(out.user.email).toBe('a@b.com');
    expect(out.beneficiary.account_number).toBe(REDACTED);
    expect(out.beneficiary.ifsc).toBe('HDFC0001234');
    expect(out.list[0]!.refreshToken).toBe(REDACTED);
  });

  it('does not mutate the input', () => {
    const input = { password: 'p' };
    redact(input);
    expect(input.password).toBe('p');
  });
});

describe('logger redaction', () => {
  it('never writes secrets to the log stream', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = pino(buildLoggerOptions({ service: 'test' }), stream);
    logger.info({ password: 'hunter2', body: { otp: '123456' }, req: { headers: { authorization: 'Bearer abc' } } });
    const out = lines.join('');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('123456');
    expect(out).not.toContain('Bearer abc');
  });
});
