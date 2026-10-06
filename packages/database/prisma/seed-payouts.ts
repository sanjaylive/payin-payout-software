/**
 * Payout reference data (development seed). Idempotent.
 *  - SYSTEM maker-checker tiers (docs/PAYOUT_FLOW.md §6): ≤ ₹10,000 auto, ≤ ₹1,00,000 one approver,
 *    above that two approvers. Without a policy every payout would need one approver (fail-safe).
 */
import { newId } from '@pay2all/auth';
import type { PrismaClient } from '../src/index';

export async function seedPayoutPolicies(db: PrismaClient): Promise<void> {
  const existing = await db.approvalPolicy.findFirst({ where: { level: 'SYSTEM', subjectId: null, service: 'PAYOUT' } });
  if (existing) return;
  await db.approvalPolicy.create({
    data: {
      id: newId('approvalPolicy'),
      level: 'SYSTEM',
      subjectId: null,
      service: 'PAYOUT',
      makerCheckerEnabled: true,
      tiers: [
        { up_to_minor: '1000000', approvals_required: 0 },
        { up_to_minor: '10000000', approvals_required: 1 },
        { up_to_minor: null, approvals_required: 2 },
      ],
    },
  });
}
