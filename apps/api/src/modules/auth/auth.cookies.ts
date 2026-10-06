import { ErrorCode } from '@pay2all/types';
import type { CookieOptions, Request, Response } from 'express';
import { AppError } from '../../common/errors/app-error';
import type { ApiConfig } from '../../config/api-config';

export const REFRESH_COOKIE = 'p2a_rt';
export const CSRF_HEADER = 'x-pay2all-csrf';
const COOKIE_PATH = '/v1/auth';

function cookieOptions(config: ApiConfig): CookieOptions {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: COOKIE_PATH,
    ...(config.env.AUTH_COOKIE_DOMAIN ? { domain: config.env.AUTH_COOKIE_DOMAIN } : {}),
  };
}

export function setRefreshCookie(res: Response, config: ApiConfig, token: string): void {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions(config), maxAge: config.env.REFRESH_TOKEN_TTL_SECONDS * 1000 });
}

export function clearRefreshCookie(res: Response, config: ApiConfig): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions(config));
}

export function readRefreshCookie(req: Request): string | null {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * CSRF defence for cookie-authenticated endpoints (docs/SECURITY.md §1.4): require a custom header
 * (impossible cross-site without passing CORS preflight) and, when present, an allow-listed Origin.
 */
export function assertCsrf(req: Request, config: ApiConfig): void {
  if (req.headers[CSRF_HEADER] !== '1') throw new AppError(ErrorCode.CSRF_REJECTED, 'Missing CSRF header');
  const origin = req.headers.origin;
  if (origin && !config.env.CORS_ALLOWED_ORIGINS.includes(origin)) {
    throw new AppError(ErrorCode.CSRF_REJECTED, 'Origin not allowed');
  }
}
