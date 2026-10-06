import type { LimitLevel } from '@pay2all/database';

/** Pure resolution logic, unit-tested independently of the database. */

export const LIMIT_FIELDS = ['perTxnMinMinor', 'perTxnMaxMinor', 'dailyAmountMinor', 'dailyCount', 'monthlyAmountMinor', 'monthlyCount'] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];
export type LimitValues = Partial<Record<LimitField, bigint | number | null>>;
export interface LimitLayer {
  level: LimitLevel;
  values: LimitValues;
}
export interface ResolvedField {
  value: bigint | number | null;
  source: LimitLevel | null;
}

/** Most specific non-null value wins, field by field. `layers` ordered most specific first. */
export function resolveLimits(layers: LimitLayer[]): Record<LimitField, ResolvedField> {
  const out = {} as Record<LimitField, ResolvedField>;
  for (const field of LIMIT_FIELDS) {
    const layer = layers.find((l) => l.values[field] !== null && l.values[field] !== undefined);
    out[field] = { value: layer ? (layer.values[field] ?? null) : null, source: layer?.level ?? null };
  }
  return out;
}

/**
 * A delegated admin (reseller) may only tighten limits: maxima can't exceed the parent's effective
 * value and the minimum can't go below it. Returns the offending fields.
 */
export function loosenedFields(proposed: LimitValues, parent: Record<LimitField, ResolvedField>): LimitField[] {
  const bad: LimitField[] = [];
  for (const field of LIMIT_FIELDS) {
    const next = proposed[field];
    const cap = parent[field].value;
    if (next === null || next === undefined || cap === null) continue;
    const tooLoose = field === 'perTxnMinMinor' ? BigInt(next) < BigInt(cap) : BigInt(next) > BigInt(cap);
    if (tooLoose) bad.push(field);
  }
  return bad;
}

export interface ApprovalTier {
  upToMinor: bigint | null;
  approvalsRequired: number;
}

export interface ApprovalPolicyShape {
  makerCheckerEnabled: boolean;
  tiers: ApprovalTier[];
}

/** Approvals needed for an amount. Maker-checker disabled ⇒ 0. */
export function approvalsRequired(policy: ApprovalPolicyShape, amountMinor: bigint): number {
  if (!policy.makerCheckerEnabled) return 0;
  const tier = policy.tiers.find((t) => t.upToMinor === null || amountMinor <= t.upToMinor);
  return tier?.approvalsRequired ?? policy.tiers[policy.tiers.length - 1]?.approvalsRequired ?? 0;
}

/** True when `child` requires fewer approvals than `parent` for some amount (checked at every boundary). */
export function isLooserPolicy(child: ApprovalPolicyShape, parent: ApprovalPolicyShape): boolean {
  const points = new Set<bigint>([1n]);
  for (const t of [...child.tiers, ...parent.tiers]) {
    if (t.upToMinor !== null) {
      points.add(t.upToMinor);
      points.add(t.upToMinor + 1n);
    }
  }
  return [...points].some((p) => approvalsRequired(child, p) < approvalsRequired(parent, p));
}

export function parseTiers(json: unknown): ApprovalTier[] {
  if (!Array.isArray(json)) return [];
  return json.map((t: { up_to_minor?: string | null; approvals_required?: number }) => ({
    upToMinor: t.up_to_minor === null || t.up_to_minor === undefined ? null : BigInt(t.up_to_minor),
    approvalsRequired: Number(t.approvals_required ?? 0),
  }));
}

export function serializeTiers(tiers: ApprovalTier[]) {
  return tiers.map((t) => ({ up_to_minor: t.upToMinor === null ? null : t.upToMinor.toString(), approvals_required: t.approvalsRequired }));
}
