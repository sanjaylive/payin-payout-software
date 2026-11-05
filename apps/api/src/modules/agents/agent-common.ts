import type { AgentPlan } from '@pay2all/database';
import { minorToMajorString } from '@pay2all/ledger';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import type { Actor } from '../auth/actor';

/** The agent organization the actor works for. Agent endpoints are for agent accounts only. */
export function agentOnly(actor: Actor): string {
  if (actor.organizationType !== 'AGENT') throw new AppError(ErrorCode.FORBIDDEN, 'This is for agent accounts');
  return actor.organizationId;
}

export function platformOnly(actor: Actor): void {
  if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
}

const IST_OFFSET_MS = 330 * 60_000;

/** Start of the IST calendar day containing `d`, as a UTC instant. */
export function istDayStart(d = new Date()): Date {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS);
}

/** Start of the IST calendar month containing `d`. */
export function istMonthStart(d = new Date()): Date {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_OFFSET_MS);
}

/** An IST date string (YYYY-MM-DD) → the UTC instant its day starts. */
export function istDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);
}

/** UTC instant → IST date string (YYYY-MM-DD). */
export function istDateString(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Inclusive IST date range → [gte, lt) instants; at most `maxDays` days. */
export function istRange(from: string, to: string, maxDays = 366): { gte: Date; lt: Date } {
  const gte = istDate(from);
  const lt = new Date(istDate(to).getTime() + 86_400_000);
  if (lt <= gte) throw new AppError(ErrorCode.INVALID_REQUEST, 'The end date is before the start date', [{ path: 'to', message: 'Before the start date' }]);
  if (lt.getTime() - gte.getTime() > maxDays * 86_400_000) throw new AppError(ErrorCode.INVALID_REQUEST, `Choose at most ${maxDays} days`, [{ path: 'from', message: 'Range too long' }]);
  return { gte, lt };
}

export const money = (minor: bigint | null | undefined) => minorToMajorString(minor ?? 0n);

export function presentPlan(p: AgentPlan) {
  return {
    code: p.code,
    name: p.name,
    description: p.description,
    price_monthly: money(p.priceMonthlyMinor),
    price_yearly: money(p.priceYearlyMinor),
    monthly_txn_limit: p.monthlyTxnLimit,
    staff_limit: p.staffLimit,
    drive_backup: p.driveBackup,
    branded_receipts: p.brandedReceipts,
    messaging: p.messaging,
    active: p.active,
  };
}

/** Mask all but the last 4 characters. */
export const last4 = (v: string) => v.replace(/\s+/g, '').slice(-4);
export const maskAccount = (l4: string | null) => (l4 ? `XXXX${l4}` : null);
