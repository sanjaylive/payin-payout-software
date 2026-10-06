import { type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../common/errors/app-error';
import type { Actor } from '../auth/actor';
import { AuthenticatedOnly, Public, RequirePermissions } from './decorators';
import { PermissionGuard } from './permission.guard';

class Handlers {
  @Public() publicRoute() {}
  @RequirePermissions('payout.approve') approve() {}
  @AuthenticatedOnly() me() {}
  undecorated() {}
}

const actor = (perms: string[]): Actor => ({
  kind: 'user',
  userId: 'usr_x',
  sessionId: 'ses_x',
  organizationId: 'org_x',
  organizationType: 'MERCHANT',
  organizationParentId: null,
  roleKeys: [],
  permissions: new Set(perms) as Actor['permissions'],
  restricted: false,
});

function contextFor(handler: keyof Handlers, a?: Actor): ExecutionContext {
  return {
    getHandler: () => Handlers.prototype[handler],
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => ({ actor: a }) }),
  } as unknown as ExecutionContext;
}

describe('PermissionGuard', () => {
  const guard = new PermissionGuard(new Reflector());

  it('allows public routes without an actor', () => {
    expect(guard.canActivate(contextFor('publicRoute'))).toBe(true);
  });

  it('allows when the actor holds every required permission', () => {
    expect(guard.canActivate(contextFor('approve', actor(['payout.approve'])))).toBe(true);
  });

  it('denies when a permission is missing', () => {
    expect(() => guard.canActivate(contextFor('approve', actor(['payout.read'])))).toThrow(AppError);
  });

  it('fails closed for routes without any authorization metadata', () => {
    expect(() => guard.canActivate(contextFor('undecorated', actor(['payout.approve'])))).toThrow(AppError);
  });

  it('allows explicit authenticated-only routes', () => {
    expect(guard.canActivate(contextFor('me', actor([])))).toBe(true);
  });
});
