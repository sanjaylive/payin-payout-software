/**
 * Default platform pricing (development seed). Created once; later edits go through the pricing API,
 * which creates new plans rather than mutating these (transaction snapshots stay explainable).
 *
 *   MERCHANT       payin 0.18%  payout ₹5.00 flat
 *   WHOLESALE      payin 0.14%  payout ₹4.00 flat   (what a reseller pays the platform)
 *   PROVIDER_COST  payin 0.10%  payout ₹3.00 flat   (what providers charge Pay2All)
 *   GST 18% on the fee.
 */
import { newId } from '@pay2all/auth';
import type { PricingPlanKind, PrismaClient } from '../src/index';

const PLANS: { kind: PricingPlanKind; name: string; payinRateMicros: bigint; payoutFlatMinor: bigint }[] = [
  { kind: 'MERCHANT', name: 'Standard merchant pricing', payinRateMicros: 180_000n, payoutFlatMinor: 500n },
  { kind: 'WHOLESALE', name: 'Standard reseller wholesale', payinRateMicros: 140_000n, payoutFlatMinor: 400n },
  { kind: 'PROVIDER_COST', name: 'Standard provider cost', payinRateMicros: 100_000n, payoutFlatMinor: 300n },
];

export async function seedPricing(db: PrismaClient, platformOrgId: string): Promise<void> {
  for (const p of PLANS) {
    const exists = await db.pricingPlan.findFirst({ where: { kind: p.kind, ownerOrgId: platformOrgId, isDefault: true, status: 'ACTIVE' } });
    if (exists) continue;
    const planId = newId('pricingPlan');
    await db.pricingPlan.create({
      data: {
        id: planId,
        name: p.name,
        kind: p.kind,
        ownerOrgId: platformOrgId,
        isDefault: true,
        effectiveFrom: new Date('2026-01-01T00:00:00+05:30'),
        rules: {
          create: [
            { id: newId('pricingRule'), service: 'PAYIN', chargeType: 'PERCENTAGE', rateMicros: p.payinRateMicros },
            { id: newId('pricingRule'), service: 'PAYOUT', chargeType: 'FLAT', flatMinor: p.payoutFlatMinor },
          ],
        },
      },
    });
  }
}
