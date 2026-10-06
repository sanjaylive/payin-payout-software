import path from 'node:path';
import { createKeyring, FieldEncryptor, newId } from '@pay2all/auth';
import { createPrismaClient } from '@pay2all/database';
import { createLogger } from '@pay2all/logger';
import { config as loadDotenv } from 'dotenv';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { providerHealthJob } from './provider-health-job';

loadDotenv({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
const prisma = createPrismaClient({ url: process.env.TEST_DATABASE_URL!, poolMax: 2 });
const redis = new Redis(`${(process.env.REDIS_URL ?? 'redis://localhost:56379').replace(/\/\d+$/, '')}/1`);
const keyId = process.env.ENCRYPTION_KEY_ID ?? 'k1';
const key = process.env.ENCRYPTION_KEY!;
const logger = createLogger({ service: 'test', level: 'silent' });

async function provider(status: 'ACTIVE' | 'MAINTENANCE', simulateDown: boolean) {
  const id = newId('provider');
  await prisma.provider.create({
    data: { id, code: `hc-${id.slice(-8).toLowerCase()}`, name: 'Health test', kind: 'PAYOUT', adapter: 'mock', status, statusSource: status === 'ACTIVE' ? 'AUTO' : 'MANUAL', config: { simulate_down: simulateDown } },
  });
  const enc = new FieldEncryptor(createKeyring(keyId, { [keyId]: key }));
  await prisma.providerCredential.create({ data: { id: newId('providerCredential'), providerId: id, environment: 'TEST', secretEncrypted: enc.encrypt(JSON.stringify({ webhook_secret: 'x' }), `${id}:TEST`), fingerprints: {} } });
  return id;
}

let minute = Date.UTC(2026, 9, 6, 10, 0);
const job = () => providerHealthJob(prisma, redis, logger, key, keyId);
const tick = async () => job().run(new Date((minute += 60_000)));
const status = async (id: string) => (await prisma.provider.findUniqueOrThrow({ where: { id } })).status;

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});

describe('provider health job', () => {
  it('takes an unreachable provider DOWN after consecutive failed probes, then recovers it via half-open', async () => {
    const id = await provider('ACTIVE', true);
    await tick();
    await tick();
    expect(await status(id)).toBe('ACTIVE');
    await tick();
    expect(await status(id)).toBe('DOWN');
    expect(await prisma.auditLog.count({ where: { resourceId: id, action: 'provider.status_changed' } })).toBe(1);

    await prisma.provider.update({ where: { id }, data: { config: { simulate_down: false } } });
    await tick();
    await tick();
    await tick();
    expect(await status(id)).toBe('DEGRADED');
    await tick();
    expect(await status(id)).toBe('ACTIVE');
    const events = await prisma.outboxEvent.findMany({ where: { aggregateId: id }, orderBy: { occurredAt: 'asc' } });
    expect(events.map((e) => (e.payload as { to: string }).to)).toEqual(['DOWN', 'DEGRADED', 'ACTIVE']);
  });

  it('never touches manual statuses', async () => {
    const id = await provider('MAINTENANCE', true);
    for (let i = 0; i < 4; i++) await tick();
    expect(await status(id)).toBe('MAINTENANCE');
  });
});
