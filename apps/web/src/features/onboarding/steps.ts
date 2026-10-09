import { Building2, FileText, Landmark, type LucideIcon, Send, Store, Users } from 'lucide-react';
import type { MerchantApplication, Requirement } from '@/lib/api/types';

export type StepKey = 'business' | 'activity' | 'people' | 'bank' | 'documents' | 'review';

export interface StepDef {
  key: StepKey;
  title: string;
  short: string;
  description: string;
  icon: LucideIcon;
  /** Which server requirements (compliance-requirements.ts keys) this step satisfies. */
  owns: (key: string) => boolean;
  minutes: number;
}

const BUSINESS_KEYS = ['profile.identity', 'profile.pan', 'profile.gstin_pan', 'profile.cin', 'profile.llpin', 'profile.address'];
const ACTIVITY_KEYS = ['profile.online_presence', 'profile.business', 'profile.volumes', 'profile.services', 'profile.contact'];

export const STEPS: StepDef[] = [
  { key: 'business', title: 'Business identity', short: 'Business', description: 'Legal name, entity type, PAN and registered address.', icon: Building2, owns: (k) => BUSINESS_KEYS.includes(k), minutes: 3 },
  { key: 'activity', title: 'What you sell', short: 'Activity', description: 'Your website, category, expected volumes and the services you need.', icon: Store, owns: (k) => ACTIVITY_KEYS.includes(k), minutes: 3 },
  { key: 'people', title: 'Directors and owners', short: 'People', description: 'Directors, partners or the proprietor, beneficial owners and who signs for the business.', icon: Users, owns: (k) => k.startsWith('persons.'), minutes: 2 },
  { key: 'bank', title: 'Settlement account', short: 'Bank', description: 'The current account in the business name where we pay your settlements.', icon: Landmark, owns: (k) => k.startsWith('bank.'), minutes: 1 },
  { key: 'documents', title: 'KYC documents', short: 'Documents', description: 'Clear scans of the documents your business type needs.', icon: FileText, owns: (k) => k.startsWith('documents.'), minutes: 4 },
  { key: 'review', title: 'Review and submit', short: 'Submit', description: 'Check everything once, then send it to our compliance team.', icon: Send, owns: () => false, minutes: 1 },
];

export interface StepProgress {
  step: StepDef;
  items: Requirement[];
  done: number;
  total: number;
  complete: boolean;
}

/** Submission-stage progress per step, from the server's requirements (the single source of truth). */
export function stepProgress(app: MerchantApplication): StepProgress[] {
  const submission = app.requirements.filter((r) => r.stage === 'SUBMISSION');
  return STEPS.map((step) => {
    if (step.key === 'review') return { step, items: [], done: app.can_submit ? 1 : 0, total: 1, complete: app.can_submit };
    const items = submission.filter((r) => step.owns(r.key));
    const done = items.filter((r) => r.satisfied).length;
    return { step, items, done, total: items.length, complete: items.length > 0 && done === items.length };
  });
}

export function overall(app: MerchantApplication): { done: number; total: number; percent: number } {
  const submission = app.requirements.filter((r) => r.stage === 'SUBMISSION');
  const done = submission.filter((r) => r.satisfied).length;
  const total = Math.max(submission.length, 1);
  return { done, total: submission.length, percent: Math.floor((done / total) * 100) };
}

export const isStepKey = (v: string | null): v is StepKey => STEPS.some((s) => s.key === v);
