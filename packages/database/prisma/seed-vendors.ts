import { newId } from '@pay2all/auth';
import type { NotificationChannel, Prisma, PrismaClient } from '../src/index';

/**
 * Starter messaging vendors (docs/VENDORS.md §4), development only. Services are DISABLED and have
 * no credentials: add the API key / SES keys and templates on Settings → API Vendors, send a test,
 * then switch them on. Existing vendors and services are never modified.
 */
const STARTERS: Array<{ code: string; name: string; website: string; services: Array<{ channel: NotificationChannel; adapter: string; name: string; priority: number; config: Prisma.InputJsonObject }> }> = [
  {
    code: 'sms21',
    name: 'SMS21',
    website: 'https://sms21.in',
    services: [
      { channel: 'SMS', adapter: 'sms21', name: 'SMS21 SMS', priority: 10, config: { base_url: 'https://api.sms21.in/v1', templates: {} } },
      { channel: 'WHATSAPP', adapter: 'sms21', name: 'SMS21 WhatsApp', priority: 10, config: { base_url: 'https://api.sms21.in/v1', templates: {} } },
    ],
  },
  {
    code: 'amazon-web-services',
    name: 'Amazon Web Services',
    website: 'https://aws.amazon.com/ses/',
    services: [{ channel: 'EMAIL', adapter: 'ses', name: 'Amazon SES (Mumbai)', priority: 10, config: { region: 'ap-south-1', from_address: 'no-reply@pay2all.local', from_name: 'Pay2All Payments', use_instance_role: false } }],
  },
];

export async function seedVendors(db: PrismaClient): Promise<void> {
  for (const s of STARTERS) {
    if (await db.apiVendor.findUnique({ where: { code: s.code } })) continue;
    const vendor = await db.apiVendor.create({ data: { id: newId('apiVendor'), code: s.code, name: s.name, website: s.website } });
    for (const svc of s.services) {
      await db.messagingService.create({ data: { id: newId('messagingService'), vendorId: vendor.id, status: 'DISABLED', ...svc } });
    }
  }
}
