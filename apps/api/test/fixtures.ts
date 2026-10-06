import { gstinCheckChar } from '@pay2all/validation';

export const pdf = (label = 'test') => Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
export const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export const gstinFor = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckChar(`${state}${pan}1Z`)}`;

/** Random synthetic LLP PAN (4th char F) so parallel runs never collide. */
export function llpPan(): string {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const pick = () => L[Math.floor(Math.random() * L.length)]!;
  return `${pick()}${pick()}${pick()}F${pick()}${String(Math.floor(1000 + Math.random() * 8999))}${pick()}`;
}

export function completeLlpProfile(pan: string) {
  return {
    legal_name: 'Test Traders LLP',
    display_name: 'Test Traders',
    entity_type: 'LLP',
    pan,
    gstin: gstinFor('27', pan),
    llpin: 'AAB-1234',
    registered_address: { line1: '1 Test Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    website: 'https://test-traders.example',
    business_category: 'Electronics retail',
    mcc: '5732',
    business_description: 'Retail of consumer electronics online and in stores.',
    expected_monthly_volume: '5000000.00',
    average_ticket_size: '2500.00',
    maximum_ticket_size: '150000.00',
    payin_required: true,
    payout_required: true,
    settlement_preference: 'T1',
    contact_name: 'Test Owner',
    contact_email: 'owner@test-traders.example',
    contact_mobile: '9876512345',
  };
}
