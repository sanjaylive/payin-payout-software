import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@pay2all/auth';
import type { Request } from 'express';
import type { Actor } from '../auth/actor';

export const IS_PUBLIC = 'pay2all:isPublic';
export const REQUIRED_PERMISSIONS = 'pay2all:requiredPermissions';
export const AUTHENTICATED_ONLY = 'pay2all:authenticatedOnly';
export const ANY_PERMISSIONS = 'pay2all:anyPermissions';
export const ALLOW_RESTRICTED_SESSION = 'pay2all:allowRestrictedSession';

/** No authentication. Use sparingly (login, refresh, health, password reset). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Actor must hold ALL listed permissions in the session's active organization. */
export const RequirePermissions = (...permissions: PermissionKey[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Actor must hold AT LEAST ONE of the listed permissions (e.g. applicant or reviewer may upload). */
export const RequireAnyPermission = (...permissions: PermissionKey[]) => SetMetadata(ANY_PERMISSIONS, permissions);

/** Any authenticated user (self-service routes like /auth/me). Explicit so nothing is open by omission. */
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY, true);

/** Reachable from a restricted (MFA-enrollment-pending) session. */
export const AllowRestrictedSession = () => SetMetadata(ALLOW_RESTRICTED_SESSION, true);

export interface RequestWithActor extends Request {
  actor?: Actor;
}

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<RequestWithActor>();
  if (!req.actor) throw new Error('CurrentActor used on a route without authentication');
  return req.actor;
});
