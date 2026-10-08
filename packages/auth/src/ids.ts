import { monotonicFactory } from 'ulid';

/**
 * Prefixed, time-sortable identifiers (docs/ARCHITECTURE.md ADR-3).
 * Monotonic within a process so IDs generated in the same millisecond still sort correctly.
 */
export const ID_PREFIXES = {
  organization: 'org',
  user: 'usr',
  role: 'rol',
  membership: 'mem',
  session: 'ses',
  refreshToken: 'rtk',
  mfaFactor: 'mfa',
  passwordReset: 'pwr',
  auditLog: 'aud',
  outboxEvent: 'obx',
  notification: 'ntf',
  request: 'req',
  merchantPerson: 'mpr',
  merchantDocument: 'doc',
  bankAccount: 'mba',
  complianceReview: 'crv',
  limitConfig: 'lim',
  approvalPolicy: 'apl',
  salesLead: 'lead',
  recoveryCode: 'mrc',
  adjustment: 'adj',
  adjustmentApproval: 'ada',
  balanceSnapshot: 'bsn',
  provider: 'prv',
  providerCredential: 'pcr',
  providerRoute: 'prt',
  providerHealth: 'phs',
  providerWebhook: 'pwe',
  attempt: 'att',
  idempotency: 'idem',
  pricingPlan: 'ppl',
  pricingRule: 'prl',
  pricingAssignment: 'pas',
  pricingSnapshot: 'tps',
  scheme: 'sch',
  schemeRate: 'scr',
  collectionAccount: 'cac',
  fundRequest: 'fnd',
  website: 'web',
  checkoutSession: 'cs',
  payment: 'pay',
  payout: 'pout',
  refund: 'rfnd',
  beneficiary: 'ben',
  payoutAttempt: 'pat',
  payoutApproval: 'pap',
  bulkBatch: 'bpb',
  bulkRow: 'bpr',
  journal: 'jrnl',
  ledgerEntry: 'lent',
  ledgerAccount: 'lacc',
  settlement: 'stl',
  settlementHold: 'sth',
  reconRun: 'rcn',
  reconEntry: 'rce',
  remittance: 'prm',
  apiKey: 'key',
  ipAllowlist: 'ipa',
  dashboardIpRule: 'dip',
  apiRequest: 'apr',
  riskRule: 'rrl',
  riskEvent: 'rev',
  riskAction: 'rac',
  reportExport: 'rpt',
  apiVendor: 'avd',
  messagingService: 'msv',
  loginEvent: 'lge',
  inboxNotification: 'inb',
  storageBackend: 'stb',
  commissionPayout: 'cmp',
  webhookEvent: 'evt',
  webhookDelivery: 'whd',
  webhookEndpoint: 'whe',
  webhookAttempt: 'wha',
  deadLetter: 'dlq',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const nextUlid = monotonicFactory();

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${nextUlid()}`;
}

const ID_PATTERN = /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isIdOf(kind: IdKind, value: string): boolean {
  return ID_PATTERN.test(value) && value.startsWith(`${ID_PREFIXES[kind]}_`);
}
