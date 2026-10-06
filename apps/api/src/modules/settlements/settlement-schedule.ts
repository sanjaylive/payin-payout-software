/** IST settlement calendar maths (pure; calendar days — bank holidays arrive with the Phase 10 calendar). */
export const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** IST business date (YYYY-MM-DD) of an instant. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Instant of `cutoffMinute` IST on the given IST date. */
export function cutoffInstant(date: string, cutoffMinute: number): Date {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - IST_OFFSET_MS + cutoffMinute * 60_000);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function cycleDays(cycle: 'T0' | 'T1' | 'T2' | 'CUSTOM', customDays: number | null): number {
  return cycle === 'T0' ? 0 : cycle === 'T1' ? 1 : cycle === 'T2' ? 2 : (customDays ?? 3);
}

/**
 * For a run on IST date R (due once R's cutoff has passed): payments captured before the cutoff of
 * R − N are settled. T0 settles the same day's captures; T1 yesterday's; and so on.
 */
export function settlementWindow(now: Date, cfg: { cycle: 'T0' | 'T1' | 'T2' | 'CUSTOM'; customDays: number | null; cutoffMinute: number }) {
  const settlementDate = istDate(now);
  const due = now >= cutoffInstant(settlementDate, cfg.cutoffMinute);
  const periodEnd = cutoffInstant(addDays(settlementDate, -cycleDays(cfg.cycle, cfg.customDays)), cfg.cutoffMinute);
  return { settlementDate, due, periodEnd };
}

export const minuteToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const hhmmToMinute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
