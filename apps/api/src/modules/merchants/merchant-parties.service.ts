import { Inject, Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import { isUniqueViolation, type PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { maskTail, type merchantBankAccountSchema, type merchantPersonSchema } from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { NotificationsService } from '../../infra/notifications.service';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { MerchantAccessService } from './merchant-access.service';
import { presentBankAccount, presentPerson } from './merchant.presenter';

/** Directors/UBOs and settlement bank accounts. Sensitive numbers are encrypted with AAD = merchant id. */
@Injectable()
export class MerchantPartiesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: MerchantAccessService,
    private readonly encryptor: FieldEncryptor,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private personData(merchantId: string, input: z.output<typeof merchantPersonSchema>) {
    return {
      fullName: input.full_name,
      designation: input.designation ?? null,
      panEncrypted: this.encryptor.encrypt(input.pan, merchantId),
      panMasked: maskTail(input.pan, 4),
      panHash: this.encryptor.blindIndex(input.pan, 'person-pan'),
      din: input.din ?? null,
      email: input.email ?? null,
      mobile: input.mobile ?? null,
      isDirector: input.is_director,
      isUbo: input.is_ubo,
      isAuthorizedSignatory: input.is_authorized_signatory,
      ownershipPercent: input.ownership_percent ?? null,
    };
  }

  async addPerson(actor: Actor, merchantId: string, input: z.output<typeof merchantPersonSchema>) {
    await this.access.requireEditable(actor, merchantId);
    return this.prisma.$transaction(async (tx) => {
      const person = await tx.merchantPerson.create({ data: { id: newId('merchantPerson'), merchantId, ...this.personData(merchantId, input) } });
      await this.audit.record({ action: 'merchant.person.added', resourceType: 'merchant_person', resourceId: person.id, organizationId: merchantId, newValue: presentPerson(person) }, tx);
      return presentPerson(person);
    });
  }

  async updatePerson(actor: Actor, merchantId: string, personId: string, input: z.output<typeof merchantPersonSchema>) {
    await this.access.requireEditable(actor, merchantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.merchantPerson.findFirst({ where: { id: personId, merchantId } });
      if (!before) throw new AppError(ErrorCode.NOT_FOUND, 'Person not found');
      const after = await tx.merchantPerson.update({ where: { id: personId }, data: { ...this.personData(merchantId, input), kycStatus: 'PENDING' } });
      await this.audit.record({ action: 'merchant.person.updated', resourceType: 'merchant_person', resourceId: personId, organizationId: merchantId, oldValue: presentPerson(before), newValue: presentPerson(after) }, tx);
      return presentPerson(after);
    });
  }

  async removePerson(actor: Actor, merchantId: string, personId: string) {
    await this.access.requireEditable(actor, merchantId);
    await this.prisma.$transaction(async (tx) => {
      const person = await tx.merchantPerson.findFirst({ where: { id: personId, merchantId } });
      if (!person) throw new AppError(ErrorCode.NOT_FOUND, 'Person not found');
      if (await tx.merchantDocument.count({ where: { personId } })) {
        throw new AppError(ErrorCode.CONFLICT, 'This person has KYC documents on file and cannot be removed');
      }
      await tx.merchantPerson.delete({ where: { id: personId } });
      await this.audit.record({ action: 'merchant.person.removed', resourceType: 'merchant_person', resourceId: personId, organizationId: merchantId, oldValue: presentPerson(person) }, tx);
    });
    return { removed: true };
  }

  /**
   * Add a settlement account. Allowed before and after approval (account changes happen), but a new
   * account after approval starts unverified and can't become primary until compliance verifies it —
   * protecting merchants against settlement-account takeover.
   */
  async addBankAccount(actor: Actor, merchantId: string, input: z.output<typeof merchantBankAccountSchema>) {
    const merchant = await this.access.require(actor, merchantId);
    if (merchant.status === 'REJECTED') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Application was rejected');
    const hash = this.encryptor.blindIndex(`${input.ifsc.slice(0, 4)}:${input.account_number}`, 'bank-account');

    try {
      const account = await this.prisma.$transaction(async (tx) => {
        const hasPrimary = (await tx.merchantBankAccount.count({ where: { merchantId, isPrimary: true, isActive: true } })) > 0;
        const created = await tx.merchantBankAccount.create({
          data: {
            id: newId('bankAccount'),
            merchantId,
            accountHolderName: input.account_holder_name,
            accountNumberEncrypted: this.encryptor.encrypt(input.account_number, merchantId),
            accountNumberMasked: maskTail(input.account_number, 4),
            accountNumberHash: hash,
            ifsc: input.ifsc,
            bankName: input.bank_name ?? null,
            accountType: input.account_type,
            isPrimary: !hasPrimary,
            createdById: actor.userId,
          },
        });
        await this.audit.record({ action: 'merchant.bank_account.added', resourceType: 'merchant_bank_account', resourceId: created.id, organizationId: merchantId, newValue: presentBankAccount(created) }, tx);
        return created;
      });
      if (merchant.status === 'APPROVED') await this.notifyOwners(merchantId, 'A new settlement bank account was added', `Account ${account.accountNumberMasked} (${account.ifsc}) was added to your {{short}} account. It will be used only after verification. If you did not make this change, contact support immediately.`);
      return presentBankAccount(account);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(ErrorCode.CONFLICT, 'This bank account is already registered');
      throw err;
    }
  }

  async setPrimaryBankAccount(actor: Actor, merchantId: string, accountId: string) {
    const merchant = await this.access.require(actor, merchantId);
    const account = await this.prisma.merchantBankAccount.findFirst({ where: { id: accountId, merchantId, isActive: true } });
    if (!account) throw new AppError(ErrorCode.NOT_FOUND, 'Bank account not found');
    if (merchant.status !== 'DRAFT' && merchant.status !== 'MORE_INFORMATION_REQUIRED' && account.verificationStatus !== 'VERIFIED') {
      throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'Only verified accounts can become the primary settlement account');
    }
    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.merchantBankAccount.findFirst({ where: { merchantId, isPrimary: true, isActive: true } });
      await tx.merchantBankAccount.updateMany({ where: { merchantId, isPrimary: true }, data: { isPrimary: false } });
      await tx.merchantBankAccount.update({ where: { id: accountId }, data: { isPrimary: true } });
      await this.audit.record({ action: 'merchant.bank_account.primary_changed', resourceType: 'merchant_bank_account', resourceId: accountId, organizationId: merchantId, oldValue: { primary: previous?.id ?? null }, newValue: { primary: accountId } }, tx);
    });
    if (merchant.status === 'APPROVED') await this.notifyOwners(merchantId, 'Your settlement bank account changed', `Settlements will now go to account ${account.accountNumberMasked} (${account.ifsc}). If you did not make this change, contact support immediately.`);
    return { primary_account_id: accountId };
  }

  async deactivateBankAccount(actor: Actor, merchantId: string, accountId: string) {
    await this.access.require(actor, merchantId);
    const account = await this.prisma.merchantBankAccount.findFirst({ where: { id: accountId, merchantId, isActive: true } });
    if (!account) throw new AppError(ErrorCode.NOT_FOUND, 'Bank account not found');
    if (account.isPrimary) throw new AppError(ErrorCode.CONFLICT, 'Make another account primary before removing this one');
    await this.prisma.$transaction(async (tx) => {
      await tx.merchantBankAccount.update({ where: { id: accountId }, data: { isActive: false } });
      await this.audit.record({ action: 'merchant.bank_account.deactivated', resourceType: 'merchant_bank_account', resourceId: accountId, organizationId: merchantId }, tx);
    });
    return { deactivated: true };
  }

  private async notifyOwners(merchantId: string, subject: string, text: string) {
    const owners = await this.prisma.userRole.findMany({
      where: { organizationId: merchantId, role: { key: { in: ['MERCHANT_OWNER', 'MERCHANT_ADMIN'] } }, user: { status: 'ACTIVE' } },
      select: { user: { select: { email: true } } },
    });
    for (const { user } of owners) await this.notifications.queue(this.prisma, { to: user.email, subject, text, template: 'settlement_account_changed' });
  }
}
