import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@pay2all/auth';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { ANY_PERMISSIONS, AUTHENTICATED_ONLY, IS_PUBLIC, REQUIRED_PERMISSIONS, type RequestWithActor } from './decorators';

/**
 * Enforces @RequirePermissions. Fails closed: a non-public route that declares neither
 * @RequirePermissions nor @AuthenticatedOnly is rejected, so a forgotten decorator can never expose
 * an endpoint.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const required = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(REQUIRED_PERMISSIONS, targets);
    const anyOf = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(ANY_PERMISSIONS, targets);
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY, targets);
    const actor = context.switchToHttp().getRequest<RequestWithActor>().actor;
    if (!actor) throw new AppError(ErrorCode.UNAUTHORIZED);

    if (anyOf?.length) {
      if (!anyOf.some((p) => actor.permissions.has(p))) throw new AppError(ErrorCode.FORBIDDEN);
      if (!required?.length) return true;
    }

    if (!required?.length) {
      if (authenticatedOnly) return true;
      this.logger.error(
        { handler: `${context.getClass().name}.${context.getHandler().name}` },
        'Route has no authorization metadata — denying',
      );
      throw new AppError(ErrorCode.FORBIDDEN);
    }

    const missing = required.filter((p) => !actor.permissions.has(p));
    if (missing.length) throw new AppError(ErrorCode.FORBIDDEN);
    return true;
  }
}
