import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import type Redis from 'ioredis';
import { AppError } from '../../common/errors/app-error';
import { PRISMA, REDIS } from '../../infra/tokens';
import { Public } from '../access/decorators';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: the process is up. Never touches dependencies (avoids restart storms). */
  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable; load balancers stop routing when this fails. */
  @Public()
  @Get('ready')
  @HttpCode(200)
  async ready() {
    const [db, redis] = await Promise.allSettled([this.prisma.$queryRaw`SELECT 1`, this.redis.ping()]);
    const checks = { database: db.status === 'fulfilled', redis: redis.status === 'fulfilled' };
    if (!checks.database || !checks.redis) throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Dependencies unavailable');
    return { status: 'ok', checks };
  }
}
