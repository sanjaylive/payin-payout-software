import { describe, expect, it } from 'vitest';
import { type ApplicationSnapshot, evaluateRequirements, unmet } from './compliance-requirements';
import { canTransition, isEditable } from './merchant-state';

const completeProfile: NonNullable<ApplicationSnapshot['profile']> = {
  legalName: 'Sharma Electronics LLP',
  displayName: 'Sharma Electronics',
  entityType: 'LLP',
  pan: 'AAPFU0939F',
  gstin: '27AAPFU0939F1ZV',
  cin: null,
  llpin: 'AAB-1234',
  registeredAddress: { line1: '12 MG Road' },
  website: 'https://sharma.example',
  appUrl: null,
  businessCategory: 'Electronics retail',
  mcc: '5732',
  businessDescription: 'Retail of consumer electronics online and in store.',
  expectedMonthlyVolumeMinor: 500000000n,
  averageTicketMinor: 500000n,
  maximumTicketMinor: 20000000n,
  payinRequired: true,
  payoutRequired: false,
  settlementPreference: 'T1',
  contactName: 'Rohit Sharma',
  contactEmail: 'rohit@sharma.example',
  contactMobile: '+919876500001',
};

function app(overrides: Partial<ApplicationSnapshot> = {}): ApplicationSnapshot {
  return {
    status: 'DRAFT',
    profile: completeProfile,
    persons: [{ isDirector: true, isUbo: true, isAuthorizedSignatory: true }],
    bankAccounts: [{ isPrimary: true, isActive: true, verificationStatus: 'PENDING' }],
    documents: (['PAN', 'ADDRESS_PROOF', 'CANCELLED_CHEQUE', 'DIRECTOR_KYC', 'GST_CERTIFICATE', 'CIN_CERTIFICATE'] as const).map((type) => ({
      type,
      status: 'UPLOADED' as const,
      expiresAt: null,
    })),
    kyc: { sanctionsStatus: 'NOT_STARTED', pepStatus: 'NOT_STARTED', adverseMediaStatus: 'NOT_STARTED' },
    ...overrides,
  };
}

describe('compliance requirements', () => {
  it('a complete LLP application can be submitted but not yet approved', () => {
    const items = evaluateRequirements(app());
    expect(unmet(items, 'SUBMISSION')).toEqual([]);
    const approvalGaps = unmet(items, 'APPROVAL').map((i) => i.key);
    expect(approvalGaps).toEqual(expect.arrayContaining(['bank.verified', 'screening', 'documents.AGREEMENT.verified']));
  });

  it('flags a PAN that does not match the entity type, and a GSTIN of another PAN', () => {
    const items = evaluateRequirements(app({ profile: { ...completeProfile, entityType: 'PRIVATE_LIMITED', cin: 'U12345MH2020PTC123456' } }));
    expect(unmet(items, 'SUBMISSION').map((i) => i.key)).toContain('profile.pan');
    const items2 = evaluateRequirements(app({ profile: { ...completeProfile, gstin: '29AAGCB7383J1Z4' } }));
    expect(unmet(items2, 'SUBMISSION').map((i) => i.key)).toContain('profile.gstin_pan');
  });

  it('requires UBOs for non-proprietorships and CIN for companies', () => {
    const items = evaluateRequirements(app({ persons: [{ isDirector: true, isUbo: false, isAuthorizedSignatory: true }] }));
    expect(unmet(items, 'SUBMISSION').map((i) => i.key)).toContain('persons.ubo');
  });

  it('ignores rejected and expired documents', () => {
    const docs = app().documents.map((d) => (d.type === 'PAN' ? { ...d, status: 'REJECTED' as const } : d));
    expect(unmet(evaluateRequirements(app({ documents: docs })), 'SUBMISSION').map((i) => i.key)).toContain('documents.PAN.uploaded');
    const expired = app().documents.map((d) => (d.type === 'PAN' ? { ...d, expiresAt: new Date('2000-01-01') } : d));
    expect(unmet(evaluateRequirements(app({ documents: expired })), 'SUBMISSION').map((i) => i.key)).toContain('documents.PAN.uploaded');
  });

  it('is fully satisfied once everything is verified and screened', () => {
    const verified = app({
      documents: [...app().documents, { type: 'AGREEMENT' as const, status: 'UPLOADED' as const, expiresAt: null }].map((d) => ({ ...d, status: 'VERIFIED' as const })),
      bankAccounts: [{ isPrimary: true, isActive: true, verificationStatus: 'VERIFIED' }],
      kyc: { sanctionsStatus: 'CLEAR', pepStatus: 'FALSE_POSITIVE', adverseMediaStatus: 'CLEAR' },
    });
    expect(unmet(evaluateRequirements(verified), 'APPROVAL')).toEqual([]);
  });
});

describe('merchant state machine', () => {
  it('allows only defined transitions', () => {
    expect(canTransition('DRAFT', 'SUBMITTED')).toBe(true);
    expect(canTransition('MORE_INFORMATION_REQUIRED', 'SUBMITTED')).toBe(true);
    expect(canTransition('SUBMITTED', 'APPROVED')).toBe(false); // must be reviewed first
    expect(canTransition('APPROVED', 'SUBMITTED')).toBe(false);
    expect(canTransition('REJECTED', 'REVIEW_STARTED')).toBe(false);
    expect(canTransition('SUSPENDED', 'REACTIVATED')).toBe(true);
  });

  it('locks onboarding data once submitted', () => {
    expect(isEditable('DRAFT')).toBe(true);
    expect(isEditable('UNDER_REVIEW')).toBe(false);
    expect(isEditable('APPROVED')).toBe(false);
  });
});
