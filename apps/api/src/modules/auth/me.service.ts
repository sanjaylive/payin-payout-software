import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@pay2all/database';
import { PRISMA } from '../../infra/tokens';
import { ApiConfig } from '../../config/api-config';
import { AccessProfileService } from '../access/access-profile.service';
import type { Actor } from './actor';
import { MfaService } from './mfa.service';

@Injectable()
export class MeService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly profiles: AccessProfileService,
    private readonly mfa: MfaService,
    private readonly config: ApiConfig,
  ) {}

  async get(actor: Actor) {
    const [user, organization, memberships, mfa, profile] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { id: true, name: true, email: true, mobile: true, status: true, lastLoginAt: true, passwordChangedAt: true },
      }),
      this.prisma.organization.findUniqueOrThrow({
        where: { id: actor.organizationId },
        select: { id: true, name: true, type: true, status: true },
      }),
      this.prisma.userRole.findMany({
        where: { userId: actor.userId },
        orderBy: { createdAt: 'asc' },
        select: { role: { select: { key: true, name: true } }, organization: { select: { id: true, name: true, type: true } } },
      }),
      this.mfa.status(actor.userId),
      this.profiles.get(actor.userId, actor.organizationId),
    ]);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        status: user.status,
        last_login_at: user.lastLoginAt,
        password_changed_at: user.passwordChangedAt,
      },
      organization,
      roles: [...actor.roleKeys],
      permissions: [...actor.permissions].sort(),
      session: { id: actor.sessionId, restricted: actor.restricted },
      mfa: {
        enabled: mfa.enabled,
        totp_enabled: mfa.totpEnabled,
        passkeys: mfa.passkeys,
        recovery_codes_remaining: mfa.recoveryCodesRemaining,
        required: this.config.env.AUTH_ENFORCE_MFA && (profile?.requiresMfa ?? false),
      },
      memberships: memberships.map((m) => ({
        organization_id: m.organization.id,
        organization_name: m.organization.name,
        organization_type: m.organization.type,
        role_key: m.role.key,
        role_name: m.role.name,
      })),
    };
  }
}
