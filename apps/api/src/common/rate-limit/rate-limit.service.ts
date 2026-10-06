import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@pay2all/types';
import type Redis from 'ioredis';
import { AppError } from '../errors/app-error';
import { REDIS } from '../../infra/tokens';

/**
 * Sliding-window-counter rate limiter (approximation using current + weighted previous window).
 * Atomic via Lua so concurrent API replicas share one accurate counter.
 */
const SLIDING_WINDOW_LUA = `
local current_key = KEYS[1]
local previous_key = KEYS[2]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local elapsed_ms = tonumber(ARGV[3])
local previous = tonumber(redis.call('GET', previous_key) or '0')
local current = tonumber(redis.call('GET', current_key) or '0')
local weighted = previous * ((window_ms - elapsed_ms) / window_ms) + current
if weighted >= limit then
  return {0, math.floor(weighted)}
end
current = redis.call('INCR', current_key)
if current == 1 then
  redis.call('PEXPIRE', current_key, window_ms * 2)
end
return {1, math.floor(weighted) + 1}
`;

export interface RateLimitRule {
  /** Logical bucket name, e.g. "login:ip". */
  name: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async consume(rule: RateLimitRule, subject: string, nowMs = Date.now()): Promise<RateLimitResult> {
    const windowMs = rule.windowSeconds * 1000;
    const windowIndex = Math.floor(nowMs / windowMs);
    const elapsed = nowMs - windowIndex * windowMs;
    const base = `rl:${rule.name}:${subject}`;
    const [allowed, count] = (await this.redis.eval(
      SLIDING_WINDOW_LUA,
      2,
      `${base}:${windowIndex}`,
      `${base}:${windowIndex - 1}`,
      rule.limit,
      windowMs,
      elapsed,
    )) as [number, number];
    return { allowed: allowed === 1, count, retryAfterSeconds: Math.ceil((windowMs - elapsed) / 1000) };
  }

  /** Consume and throw RATE_LIMITED (429 + Retry-After) when exceeded. */
  async enforce(rule: RateLimitRule, subject: string): Promise<void> {
    const result = await this.consume(rule, subject);
    if (!result.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, undefined, undefined, {
        'Retry-After': String(result.retryAfterSeconds),
      });
    }
  }

  /** Current (weighted) count without consuming — e.g. "is this IP already over its failure budget?". */
  async peek(rule: RateLimitRule, subject: string, nowMs = Date.now()): Promise<number> {
    const windowMs = rule.windowSeconds * 1000;
    const windowIndex = Math.floor(nowMs / windowMs);
    const elapsed = nowMs - windowIndex * windowMs;
    const base = `rl:${rule.name}:${subject}`;
    const [current, previous] = await this.redis.mget(`${base}:${windowIndex}`, `${base}:${windowIndex - 1}`);
    return Math.floor(Number(previous ?? 0) * ((windowMs - elapsed) / windowMs) + Number(current ?? 0));
  }

  /** Clear a bucket (e.g. per-identifier login counter after a successful login). */
  async reset(rule: RateLimitRule, subject: string, nowMs = Date.now()): Promise<void> {
    const windowIndex = Math.floor(nowMs / (rule.windowSeconds * 1000));
    const base = `rl:${rule.name}:${subject}`;
    await this.redis.del(`${base}:${windowIndex}`, `${base}:${windowIndex - 1}`);
  }
}
