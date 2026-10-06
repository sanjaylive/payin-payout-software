import { type ArgumentsHost, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppError } from './app-error';

function run(err: unknown) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(err, host);
  return { status: res.status.mock.calls[0]![0] as number, body: res.json.mock.calls[0]![0], res };
}

describe('AllExceptionsFilter', () => {
  it('maps AppError codes to their HTTP status', () => {
    const { status, body } = run(new AppError('INSUFFICIENT_BALANCE'));
    expect(status).toBe(422);
    expect(body).toMatchObject({ success: false, error: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient available balance' } });
  });

  it('maps framework exceptions', () => {
    expect(run(new NotFoundException()).body.error.code).toBe('NOT_FOUND');
  });

  it('hides internal error details', () => {
    const { status, body } = run(new Error('connection string postgres://secret@db'));
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('passes through headers like Retry-After', () => {
    const { res } = run(new AppError('RATE_LIMITED', undefined, undefined, { 'Retry-After': '30' }));
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
  });
});
