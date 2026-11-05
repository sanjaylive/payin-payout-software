import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { FieldEncryptor, newId } from '@pay2all/auth';
import { isUniqueViolation, type Prisma, type PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import {
  AGENT_TXN_DEFAULT_DIRECTION,
  type agentBeneficiarySchema,
  type agentCustomerSchema,
  type agentCustomerUpdateSchema,
  type agentListQuerySchema,
  type agentTransactionCreateSchema,
  type agentTransactionListQuerySchema,
  type agentTransactionStatusSchema,
} from '@pay2all/validation';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, keysetAfter, toPage } from '../../common/http/paginated';
import { PRISMA } from '../../infra/tokens';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { agentOnly, istRange, last4, maskAccount } from './agent-common';
import { AgentPlansService } from './agent-plans.service';
import { presentBeneficiary, presentCustomer, presentTransaction } from './agent-presenters';

const customerAad = (id: string) => `agent-customer:${id}`;
const beneficiaryAad = (id: string) => `agent-beneficiary:${id}`;
const BACKDATE_LIMIT_MS = 30 * 86_400_000;

/** Allowed status changes of a recorded transaction. */
const STATUS_FLOW: Record<string, string[]> = {
  PENDING: ['SUCCESS', 'FAILED'],
  SUCCESS: ['FAILED', 'REFUNDED'],
  FAILED: [],
  REFUNDED: [],
};

/**
 * The agent's counter (docs/AGENTS.md §3): walk-in customers, their beneficiaries, and recorded
 * transactions. Every query is filtered by the actor's own agent id; another agent's ids are 404.
 */
@Injectable()
export class AgentDeskService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
    private readonly plans: AgentPlansService,
    private readonly audit: AuditService,
  ) {}

  // ---- Customers ----------------------------------------------------------------------------------

  async listCustomers(actor: Actor, q: z.output<typeof agentListQuerySchema>) {
    const agentId = agentOnly(actor);
    const s = q.search?.trim();
    const digits = s?.replace(/\D/g, '');
    const rows = await this.prisma.agentCustomer.findMany({
      where: {
        AND: [
          { agentId },
          s ? { OR: [{ name: { contains: s, mode: 'insensitive' } }, ...(digits && digits.length >= 3 ? [{ mobile: { contains: digits } }] : [])] } : {},
          keysetAfter(decodeCursor(q.cursor)),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, (c) => presentCustomer(c));
  }

  /** Exact lookup by mobile: the first step of a money transfer ("is this customer already here?"). */
  async findCustomerByMobile(actor: Actor, mobile: string) {
    const agentId = agentOnly(actor);
    const c = await this.prisma.agentCustomer.findUnique({ where: { agentId_mobile: { agentId, mobile } } });
    return c ? this.getCustomer(actor, c.id) : null;
  }

  private async ownCustomer(agentId: string, id: string) {
    const c = await this.prisma.agentCustomer.findFirst({ where: { id, agentId } });
    if (!c) throw new AppError(ErrorCode.NOT_FOUND, 'Customer not found');
    return c;
  }

  async getCustomer(actor: Actor, id: string) {
    const agentId = agentOnly(actor);
    const c = await this.ownCustomer(agentId, id);
    const [beneficiaries, stats] = await Promise.all([
      this.prisma.agentBeneficiary.findMany({ where: { agentId, customerId: id, active: true }, orderBy: { createdAt: 'desc' } }),
      this.prisma.agentTransaction.aggregate({ where: { agentId, customerId: id }, _count: true, _max: { occurredAt: true } }),
    ]);
    return {
      ...presentCustomer(c, { transactions: stats._count, last_transaction_at: stats._max.occurredAt }),
      beneficiaries: beneficiaries.map((b) => presentBeneficiary(b, this.accountNumber(b))),
    };
  }

  /** Full ID number, for the agent filling in a bank portal. Audited. */
  async revealCustomerId(actor: Actor, id: string) {
    const agentId = agentOnly(actor);
    const c = await this.ownCustomer(agentId, id);
    if (!c.idNumberEnc) return { id_type: c.idType, id_number: null };
    await this.audit.record({ action: 'agent.customer.id_revealed', resourceType: 'agent_customer', resourceId: id, organizationId: agentId });
    return { id_type: c.idType, id_number: this.encryptor.decrypt(c.idNumberEnc, customerAad(id)) };
  }

  async createCustomer(actor: Actor, input: z.output<typeof agentCustomerSchema>) {
    const agentId = agentOnly(actor);
    const id = newId('agentCustomer');
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.agentCustomer.create({
          data: {
            id,
            agentId,
            name: input.name,
            mobile: input.mobile,
            email: input.email ?? null,
            addressLine: input.address_line,
            city: input.city,
            pincode: input.pincode ?? null,
            dateOfBirth: input.date_of_birth ? new Date(`${input.date_of_birth}T00:00:00Z`) : null,
            idType: input.id_type ?? null,
            idNumberEnc: input.id_number ? this.encryptor.encrypt(input.id_number, customerAad(id)) : null,
            idNumberLast4: input.id_number ? last4(input.id_number) : null,
            note: input.note,
            createdById: actor.userId,
          },
        });
        await this.audit.record({ action: 'agent.customer.created', resourceType: 'agent_customer', resourceId: id, organizationId: agentId }, tx);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'mobile')) throw new AppError(ErrorCode.CONFLICT, 'A customer with this mobile number already exists', [{ path: 'mobile', message: 'Already added' }]);
      throw err;
    }
    return this.getCustomer(actor, id);
  }

  async updateCustomer(actor: Actor, id: string, input: z.output<typeof agentCustomerUpdateSchema>) {
    const agentId = agentOnly(actor);
    await this.ownCustomer(agentId, id);
    const data: Prisma.AgentCustomerUpdateInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.address_line !== undefined ? { addressLine: input.address_line } : {}),
      ...(input.city !== undefined ? { city: input.city } : {}),
      ...(input.pincode !== undefined ? { pincode: input.pincode } : {}),
      ...(input.date_of_birth !== undefined ? { dateOfBirth: input.date_of_birth ? new Date(`${input.date_of_birth}T00:00:00Z`) : null } : {}),
      ...(input.id_type !== undefined ? { idType: input.id_type } : {}),
      ...(input.id_number !== undefined
        ? { idNumberEnc: input.id_number ? this.encryptor.encrypt(input.id_number, customerAad(id)) : null, idNumberLast4: input.id_number ? last4(input.id_number) : null }
        : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.agentCustomer.update({ where: { id }, data });
        await this.audit.record({ action: 'agent.customer.updated', resourceType: 'agent_customer', resourceId: id, organizationId: agentId, newValue: { fields: Object.keys(input) } }, tx);
      });
    } catch (err) {
      if (isUniqueViolation(err, 'mobile')) throw new AppError(ErrorCode.CONFLICT, 'Another customer has this mobile number', [{ path: 'mobile', message: 'Already used' }]);
      throw err;
    }
    return this.getCustomer(actor, id);
  }

  // ---- Beneficiaries ------------------------------------------------------------------------------

  private accountNumber(b: { id: string; accountNumberEnc: string | null }) {
    return b.accountNumberEnc ? this.encryptor.decrypt(b.accountNumberEnc, beneficiaryAad(b.id)) : null;
  }

  async addBeneficiary(actor: Actor, customerId: string, input: z.output<typeof agentBeneficiarySchema>) {
    const agentId = agentOnly(actor);
    await this.ownCustomer(agentId, customerId);
    const id = newId('agentBeneficiary');
    await this.prisma.$transaction(async (tx) => {
      await tx.agentBeneficiary.create({
        data: {
          id,
          agentId,
          customerId,
          name: input.name,
          bankName: input.bank_name,
          accountNumberEnc: input.account_number ? this.encryptor.encrypt(input.account_number, beneficiaryAad(id)) : null,
          accountLast4: input.account_number ? last4(input.account_number) : null,
          ifsc: input.ifsc ?? null,
          upiId: input.upi_id ?? null,
          relation: input.relation,
        },
      });
      await this.audit.record({ action: 'agent.beneficiary.created', resourceType: 'agent_beneficiary', resourceId: id, organizationId: agentId, metadata: { customer_id: customerId } }, tx);
    });
    const b = await this.prisma.agentBeneficiary.findUniqueOrThrow({ where: { id } });
    return presentBeneficiary(b, this.accountNumber(b));
  }

  async removeBeneficiary(actor: Actor, id: string) {
    const agentId = agentOnly(actor);
    const n = await this.prisma.agentBeneficiary.updateMany({ where: { id, agentId, active: true }, data: { active: false } });
    if (!n.count) throw new AppError(ErrorCode.NOT_FOUND, 'Beneficiary not found');
    await this.audit.record({ action: 'agent.beneficiary.removed', resourceType: 'agent_beneficiary', resourceId: id, organizationId: agentId });
    return { removed: true };
  }

  // ---- Transactions -------------------------------------------------------------------------------

  async createTransaction(actor: Actor, input: z.output<typeof agentTransactionCreateSchema>) {
    const agentId = agentOnly(actor);
    const occurredAt = input.occurred_at ? new Date(input.occurred_at) : new Date();
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw new AppError(ErrorCode.INVALID_REQUEST, 'The time is in the future', [{ path: 'occurred_at', message: 'In the future' }]);
    if (occurredAt.getTime() < Date.now() - BACKDATE_LIMIT_MS) throw new AppError(ErrorCode.INVALID_REQUEST, 'Transactions can be back-dated by at most 30 days', [{ path: 'occurred_at', message: 'Too old' }]);
    if (input.fee > input.amount && AGENT_TXN_DEFAULT_DIRECTION[input.type] === 'OUT') {
      throw new AppError(ErrorCode.INVALID_REQUEST, 'The fee is more than the amount', [{ path: 'fee', message: 'More than the amount' }]);
    }
    const direction = AGENT_TXN_DEFAULT_DIRECTION[input.type] ?? input.direction!;

    const customer = input.customer_id ? await this.ownCustomer(agentId, input.customer_id) : null;
    const beneficiary = input.beneficiary_id ? await this.prisma.agentBeneficiary.findFirst({ where: { id: input.beneficiary_id, agentId, customerId: input.customer_id ?? '' } }) : null;
    if (input.beneficiary_id && !beneficiary) throw new AppError(ErrorCode.NOT_FOUND, 'Beneficiary not found', [{ path: 'beneficiary_id', message: 'Not found for this customer' }]);
    const creator = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true } });

    const id = newId('agentTransaction');
    const t = await this.prisma.$transaction(async (tx) => {
      // Taking the next receipt number locks the agent's profile row, so concurrent entries of one
      // agent are serialised and the monthly allowance below cannot be overrun.
      const { receiptSeq } = await tx.agentProfile.update({ where: { id: agentId }, data: { receiptSeq: { increment: 1 } }, select: { receiptSeq: true } });
      await this.plans.assertCanRecord(agentId, tx);
      const created = await tx.agentTransaction.create({
        data: {
          id,
          agentId,
          receiptNo: `R-${String(receiptSeq).padStart(6, '0')}`,
          receiptToken: randomBytes(24).toString('base64url'),
          type: input.type,
          direction,
          mode: input.mode,
          status: input.status,
          amountMinor: input.amount,
          feeMinor: input.fee,
          reference: input.reference,
          description: input.description,
          customerId: customer?.id ?? null,
          customerName: customer?.name ?? input.customer_name ?? null,
          customerMobile: customer?.mobile ?? input.customer_mobile ?? null,
          beneficiaryId: beneficiary?.id ?? null,
          beneficiaryName: beneficiary?.name ?? null,
          beneficiaryBank: beneficiary?.bankName ?? null,
          beneficiaryAccount: beneficiary ? maskAccount(beneficiary.accountLast4) : null,
          beneficiaryIfsc: beneficiary?.ifsc ?? null,
          beneficiaryUpi: beneficiary?.upiId ?? null,
          occurredAt,
          createdById: actor.userId,
          createdByName: creator.name,
        },
      });
      await this.audit.record(
        { action: 'agent.transaction.recorded', resourceType: 'agent_transaction', resourceId: id, organizationId: agentId, newValue: { type: input.type, direction, amount: created.amountMinor.toString(), receipt_no: created.receiptNo } },
        tx,
      );
      return created;
    });
    return presentTransaction(t);
  }

  async listTransactions(actor: Actor, q: z.output<typeof agentTransactionListQuerySchema>) {
    const agentId = agentOnly(actor);
    const range = q.from || q.to ? istRange(q.from ?? '2000-01-01', q.to ?? new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10), 3660) : null;
    const s = q.search?.trim();
    const rows = await this.prisma.agentTransaction.findMany({
      where: {
        AND: [
          { agentId },
          range ? { occurredAt: range } : {},
          q.type ? { type: q.type } : {},
          q.direction ? { direction: q.direction } : {},
          q.status ? { status: q.status } : {},
          q.customer_id ? { customerId: q.customer_id } : {},
          s
            ? {
                OR: [
                  { receiptNo: { contains: s, mode: 'insensitive' } },
                  { customerName: { contains: s, mode: 'insensitive' } },
                  { customerMobile: { contains: s } },
                  { beneficiaryName: { contains: s, mode: 'insensitive' } },
                  { reference: { contains: s, mode: 'insensitive' } },
                ],
              }
            : {},
          keysetAfter(decodeCursor(q.cursor)),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    return toPage(rows, q.limit, presentTransaction);
  }

  async getTransaction(actor: Actor, id: string) {
    const agentId = agentOnly(actor);
    const t = await this.prisma.agentTransaction.findFirst({ where: { id, agentId } });
    if (!t) throw new AppError(ErrorCode.NOT_FOUND, 'Transaction not found');
    return presentTransaction(t);
  }

  async changeStatus(actor: Actor, id: string, input: z.output<typeof agentTransactionStatusSchema>) {
    const agentId = agentOnly(actor);
    const t = await this.prisma.$transaction(async (tx) => {
      const before = await tx.agentTransaction.findFirst({ where: { id, agentId } });
      if (!before) throw new AppError(ErrorCode.NOT_FOUND, 'Transaction not found');
      if (before.status === input.status) return before;
      if (!STATUS_FLOW[before.status]?.includes(input.status)) {
        throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, `A ${before.status.toLowerCase()} transaction cannot become ${input.status.toLowerCase()}`);
      }
      const n = await tx.agentTransaction.updateMany({
        where: { id, status: before.status },
        data: { status: input.status, statusNote: input.note, statusChangedAt: new Date(), ...(input.reference ? { reference: input.reference } : {}) },
      });
      if (n.count !== 1) throw new AppError(ErrorCode.CONFLICT, 'The transaction changed; reload and try again');
      await this.audit.record(
        { action: 'agent.transaction.status_changed', resourceType: 'agent_transaction', resourceId: id, organizationId: agentId, oldValue: { status: before.status }, newValue: { status: input.status, note: input.note } },
        tx,
      );
      return tx.agentTransaction.findUniqueOrThrow({ where: { id } });
    });
    return presentTransaction(t);
  }
}
