import { formatMinor } from '@pay2all/ui/lib/money';

/** Agent (customer service point) API shapes — docs/AGENTS.md §8. Amounts are rupee strings ("1500.00"). */

export type AgentTxnType = 'MONEY_TRANSFER' | 'CASH_WITHDRAWAL' | 'CASH_DEPOSIT' | 'BILL_PAYMENT' | 'RECHARGE' | 'OTHER';
export type AgentDirection = 'IN' | 'OUT';
export type AgentMode = 'CASH' | 'UPI' | 'BANK' | 'OTHER';
export type AgentTxnStatus = 'SUCCESS' | 'PENDING' | 'FAILED' | 'REFUNDED';
export type AgentPlanCode = 'FREE' | 'STARTER' | 'BUSINESS';
export type AgentIdType = 'AADHAAR' | 'PAN' | 'VOTER_ID' | 'DRIVING_LICENCE' | 'PASSPORT' | 'OTHER';

export interface AgentPlan {
  code: AgentPlanCode;
  name: string;
  description: string | null;
  price_monthly: string;
  price_yearly: string;
  monthly_txn_limit: number | null;
  staff_limit: number;
  drive_backup: boolean;
  branded_receipts: boolean;
  messaging: boolean;
  active: boolean;
}

export interface AgentCurrentPlan extends AgentPlan {
  expires_at: string | null;
  /** The paid plan that has lapsed (the agent is on Free meanwhile). */
  lapsed_from: AgentPlanCode | null;
}

export interface AgentUsage {
  transactions_this_month: number;
  staff: number;
}

export interface AgentProfile {
  id: string;
  shop_name: string;
  owner_name: string;
  email: string;
  mobile: string;
  address_line: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  upi_vpa: string | null;
  upi_payee_name: string | null;
  has_qr_image: boolean;
  has_logo: boolean;
  receipt_footer: string | null;
  created_at: string;
  plan: AgentCurrentPlan;
  usage: AgentUsage;
}

export interface AgentCustomer {
  id: string;
  name: string;
  mobile: string;
  email: string | null;
  address_line: string | null;
  city: string | null;
  pincode: string | null;
  date_of_birth: string | null;
  id_type: AgentIdType | null;
  id_number_masked: string | null;
  note: string | null;
  created_at: string;
}

export interface AgentBeneficiary {
  id: string;
  customer_id: string;
  name: string;
  bank_name: string | null;
  account_number: string | null;
  account_masked: string | null;
  ifsc: string | null;
  upi_id: string | null;
  relation: string | null;
  active: boolean;
  created_at: string;
}

export interface AgentCustomerDetail extends AgentCustomer {
  transactions: number;
  last_transaction_at: string | null;
  beneficiaries: AgentBeneficiary[];
}

export interface AgentTxn {
  id: string;
  receipt_no: string;
  type: AgentTxnType;
  direction: AgentDirection;
  mode: AgentMode;
  status: AgentTxnStatus;
  amount: string;
  fee: string;
  total: string;
  reference: string | null;
  description: string | null;
  customer: { id: string | null; name: string | null; mobile: string | null } | null;
  beneficiary: { id: string | null; name: string; bank_name: string | null; account_masked: string | null; ifsc: string | null; upi_id: string | null } | null;
  occurred_at: string;
  /** Not on the public receipt. */
  created_by?: string | null;
  status_note: string | null;
  status_changed_at: string | null;
  receipt_sent_at: string | null;
  /** Not on the public receipt. */
  receipt_token?: string;
  created_at: string;
}

export interface AgentReceipt {
  transaction: AgentTxn;
  type_label: string;
  shop: { name: string; mobile: string; address: string | null; upi_vpa: string | null; logo_url: string | null; footer: string | null };
  branded: boolean;
  powered_by: string | null;
  public_url: string;
}

export interface AgentDashboard {
  profile: AgentProfile;
  today: { money_in: string; money_out: string; fees: string; net: string; count: number };
  month: { volume: string; fees: string; count: number };
  customers: number;
  recent: AgentTxn[];
}

export interface AgentSummary {
  from: string;
  to: string;
  totals: { money_in: string; money_out: string; fees: string; net: string; count: number };
  by_type: { type: AgentTxnType; label: string; direction: AgentDirection; amount: string; fees: string; count: number }[];
  by_mode: { mode: AgentMode; direction: AgentDirection; amount: string; count: number }[];
  by_status: { status: AgentTxnStatus; amount: string; count: number }[];
  by_day: { date: string; money_in: string; money_out: string; fees: string; net: string; count: number }[];
}

export interface AgentOrder {
  id: string;
  plan_code: AgentPlanCode;
  plan_name: string;
  period: 'MONTHLY' | 'YEARLY';
  amount: string;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  checkout_url: string | null;
  period_start: string | null;
  period_end: string | null;
  paid_at: string | null;
  granted: boolean;
  created_at: string;
}

export interface AgentBilling {
  current: AgentCurrentPlan;
  usage: AgentUsage;
  plans: AgentPlan[];
  online_payment_available: boolean;
  orders: AgentOrder[];
}

export interface AgentStaffList {
  staff_limit: number;
  active: number;
  members: { user_id: string; name: string; email: string; mobile: string | null; role: string; role_name: string; active: boolean; last_login_at: string | null; is_you: boolean }[];
}

export interface AgentDrive {
  available: boolean;
  included_in_plan: boolean;
  connected: boolean;
  google_email: string | null;
  status: string | null;
  auto_backup: boolean;
  last_backup_at: string | null;
  last_error: string | null;
  folder_url: string | null;
}

// ---- Platform admin -------------------------------------------------------------------------------

export interface AgentAdminOverview {
  agents: number;
  new_this_month: number;
  by_plan: { code: AgentPlanCode; name: string; agents: number }[];
  transactions_this_month: number;
  volume_this_month: string;
  plan_revenue_this_month: string;
  plan_orders_this_month: number;
}

export interface AgentAdminRow {
  id: string;
  shop_name: string;
  owner_name: string;
  email: string;
  mobile: string;
  city: string | null;
  status: string;
  plan_code: AgentPlanCode;
  subscribed_plan_code: AgentPlanCode;
  plan_expires_at: string | null;
  transactions_this_month: number;
  created_at: string;
}

export interface AgentAdminDetail {
  id: string;
  shop_name: string;
  owner_name: string;
  email: string;
  mobile: string;
  address: string | null;
  upi_vpa: string | null;
  status: string;
  plan: AgentCurrentPlan;
  usage: AgentUsage;
  lifetime: { transactions: number; volume: string; fees: string };
  drive: { status: string; last_backup_at: string | null } | null;
  orders: { id: string; plan_code: AgentPlanCode; period: 'MONTHLY' | 'YEARLY'; amount: string; status: AgentOrder['status']; granted: boolean; period_end: string | null; paid_at: string | null; created_at: string }[];
  created_at: string;
}

export interface AgentProgramSettings {
  billing_merchant_id: string | null;
  billing_merchant_name: string | null;
  billing_ready: boolean;
}

// ---- Labels ---------------------------------------------------------------------------------------

export const TXN_TYPES: AgentTxnType[] = ['MONEY_TRANSFER', 'CASH_WITHDRAWAL', 'CASH_DEPOSIT', 'BILL_PAYMENT', 'RECHARGE', 'OTHER'];
export const TYPE_LABEL: Record<AgentTxnType, string> = {
  MONEY_TRANSFER: 'Money transfer',
  CASH_WITHDRAWAL: 'Cash withdrawal',
  CASH_DEPOSIT: 'Cash deposit',
  BILL_PAYMENT: 'Bill payment',
  RECHARGE: 'Recharge',
  OTHER: 'Other',
};
/** Fixed direction per type; OTHER is chosen per entry. */
export const TYPE_DIRECTION: Record<AgentTxnType, AgentDirection | null> = {
  MONEY_TRANSFER: 'IN',
  CASH_WITHDRAWAL: 'OUT',
  CASH_DEPOSIT: 'IN',
  BILL_PAYMENT: 'IN',
  RECHARGE: 'IN',
  OTHER: null,
};
export const MODES: AgentMode[] = ['CASH', 'UPI', 'BANK', 'OTHER'];
export const MODE_LABEL: Record<AgentMode, string> = { CASH: 'Cash', UPI: 'UPI', BANK: 'Bank', OTHER: 'Other' };
export const STATUSES: AgentTxnStatus[] = ['SUCCESS', 'PENDING', 'FAILED', 'REFUNDED'];
export const STATUS_LABEL: Record<AgentTxnStatus, string> = { SUCCESS: 'Success', PENDING: 'Pending', FAILED: 'Failed', REFUNDED: 'Refunded' };
export const ID_TYPES: AgentIdType[] = ['AADHAAR', 'PAN', 'VOTER_ID', 'DRIVING_LICENCE', 'PASSPORT', 'OTHER'];
export const ID_TYPE_LABEL: Record<AgentIdType, string> = {
  AADHAAR: 'Aadhaar',
  PAN: 'PAN',
  VOTER_ID: 'Voter ID',
  DRIVING_LICENCE: 'Driving licence',
  PASSPORT: 'Passport',
  OTHER: 'Other',
};
/** Status changes the owner may make (docs/AGENTS.md §3). */
export const NEXT_STATUSES: Record<AgentTxnStatus, AgentTxnStatus[]> = { PENDING: ['SUCCESS', 'FAILED'], SUCCESS: ['FAILED', 'REFUNDED'], FAILED: [], REFUNDED: [] };

// ---- Formatting -----------------------------------------------------------------------------------

/** "1500.00" → 150000n, exactly (no floating point). */
export function rupeesToMinor(v: string | null | undefined): bigint {
  const s = (v ?? '0').trim();
  const neg = s.startsWith('-');
  const [whole = '0', frac = ''] = s.replace(/^[-+]/, '').split('.');
  const minor = BigInt(whole || '0') * 100n + BigInt(`${frac}00`.slice(0, 2));
  return neg ? -minor : minor;
}

/** ₹1,50,000.00 with en-IN grouping. */
export const inr = (v: string | null | undefined) => formatMinor(rupeesToMinor(v));

const IST = 'Asia/Kolkata';
export function istDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—';
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST }).format(new Date(v));
}
export function istDate(v: string | Date | null | undefined): string {
  if (!v) return '—';
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: IST }).format(new Date(v));
}
export function istTime(v: string | Date): string {
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST }).format(new Date(v));
}
/** A YYYY-MM-DD IST calendar date (report dates) for display. */
export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

/** Today's IST calendar date, YYYY-MM-DD. */
export function istToday(now = Date.now()): string {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "+919876543210" → "+91 98765 43210". */
export function fmtMobile(m: string | null | undefined): string {
  if (!m) return '—';
  const d = m.replace(/\D/g, '');
  const ten = d.slice(-10);
  return ten.length === 10 ? `+91 ${ten.slice(0, 5)} ${ten.slice(5)}` : m;
}

/** WhatsApp click-to-chat: needs the number with country code, digits only. */
export function whatsappUrl(text: string, mobile?: string | null): string {
  const ten = mobile?.replace(/\D/g, '').slice(-10);
  return `https://wa.me/${ten && ten.length === 10 ? `91${ten}` : ''}?text=${encodeURIComponent(text)}`;
}

/** UPI intent for a QR: upi://pay?pa=…&pn=…[&am=…&tn=…]. Spaces as %20 (some apps mishandle "+"). */
export function upiPayload(vpa: string, name: string, amount?: string, note?: string): string {
  const parts = [`pa=${encodeURIComponent(vpa)}`, `pn=${encodeURIComponent(name)}`];
  if (amount && Number(amount) > 0) parts.push(`am=${Number(amount).toFixed(2)}`, 'cu=INR');
  if (note) parts.push(`tn=${encodeURIComponent(note.slice(0, 50))}`);
  return `upi://pay?${parts.join('&')}`;
}

/** One key per form, so a retried tap never records the same entry twice. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** "1500" / "1500.5" → "1500.00"; invalid stays as typed (the server rejects it with a message). */
export function toAmount(v: string): string {
  const s = v.trim().replace(/,/g, '');
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s).toFixed(2) : s;
}
export const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;

export type RangePreset = 'today' | 'yesterday' | 'week' | 'month' | 'last_month';
export const RANGE_PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
];

/** Inclusive IST calendar dates for a preset (weeks start on Monday). */
export function presetDates(p: RangePreset, now = Date.now()): { from: string; to: string } {
  const today = istToday(now);
  const d = new Date(`${today}T00:00:00Z`);
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'week':
      return { from: addDays(today, -((d.getUTCDay() + 6) % 7)), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'last_month': {
      const firstThis = `${today.slice(0, 8)}01`;
      const lastPrev = addDays(firstThis, -1);
      return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev };
    }
  }
}
