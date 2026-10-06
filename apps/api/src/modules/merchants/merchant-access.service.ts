import { Inject, Injectable } from '@nestjs/common';
import type { DbClient, Prisma, PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { PRISMA } from '../../infra/tokens';
import { TenantScopeService } from '../access/tenant-scope.service';
import type { Actor } from '../auth/actor';
import { isEditable } from './merchant-state';

/** Tenant-scoped merchant lookup shared by every merchant/compliance service. */
@Injectable()
export class MerchantAccessService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly scope: TenantScopeService,
  ) {}

  where(actor: Actor): Prisma.MerchantWhereInput {
    return { organization: this.scope.organizationWhere(actor) };
  }

  /** Load a merchant the actor may see — NOT_FOUND otherwise (never reveals other tenants). */
  async require(actor: Actor, merchantId: string, db: DbClient = this.prisma) {
    const merchant = await db.merchant.findFirst({
      where: { AND: [{ id: merchantId }, this.where(actor)] },
      select: { id: true, status: true, version: true, resellerId: true, payinEnabled: true, payoutEnabled: true, riskCategory: true },
    });
    if (!merchant) throw new AppError(ErrorCode.NOT_FOUND, 'Merchant not found');
    return merchant;
  }

  /** As require(), and the application must be in an editable status. */
  async requireEditable(actor: Actor, merchantId: string, db: DbClient = this.prisma) {
    const merchant = await this.require(actor, merchantId, db);
    if (!isEditable(merchant.status)) {
      throw new AppError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Onboarding details can't be changed while the application is ${merchant.status.replaceAll('_', ' ').toLowerCase()}`,
      );
    }
    return merchant;
  }
}
