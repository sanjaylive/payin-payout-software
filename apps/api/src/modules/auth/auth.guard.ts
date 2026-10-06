import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@pay2all/types';
import { RequestContextStore } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { AccessProfileService } from '../access/access-profile.service';
import { ALLOW_RESTRICTED_SESSION, IS_PUBLIC, type RequestWithActor } from '../access/decorators';
import type { Actor } from './actor';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

/**
 * Global authentication guard for dashboard routes: verifies the bearer access token, rejects revoked
 * sessions, loads the (cached) access profile and builds the Actor. Tenant context comes exclusively
 * from the session — never from request input.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly profiles: AccessProfileService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<RequestWithActor>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError(ErrorCode.UNAUTHORIZED);

    const claims = await this.tokens.verifyAccess(header.slice(7).trim());
    if (await this.sessions.isRevoked(claims.sid)) throw new AppError(ErrorCode.SESSION_EXPIRED);

    const profile = await this.profiles.get(claims.sub, claims.org);
    if (!profile) throw new AppError(ErrorCode.UNAUTHORIZED);
    if (profile.userStatus !== 'ACTIVE') throw new AppError(ErrorCode.ACCOUNT_DISABLED);
    if (profile.organizationStatus !== 'ACTIVE' && profile.organizationType !== 'PLATFORM') {
      throw new AppError(ErrorCode.FORBIDDEN, 'Organization is not active');
    }

    if (claims.rst && !this.reflector.getAllAndOverride<boolean>(ALLOW_RESTRICTED_SESSION, targets)) {
      throw new AppError(ErrorCode.MFA_ENROLLMENT_REQUIRED);
    }

    const actor: Actor = {
      kind: 'user',
      userId: claims.sub,
      sessionId: claims.sid,
      organizationId: profile.organizationId,
      organizationType: profile.organizationType,
      organizationParentId: profile.organizationParentId,
      roleKeys: profile.roleKeys,
      permissions: new Set(profile.permissions),
      restricted: claims.rst,
    };
    req.actor = actor;
    RequestContextStore.setActor(actor);
    return true;
  }
}
