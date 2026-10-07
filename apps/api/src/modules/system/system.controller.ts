import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PrismaClient } from '@pay2all/database';
import { ErrorCode } from '@pay2all/types';
import { AppError } from '../../common/errors/app-error';
import { ApiConfig } from '../../config/api-config';
import { PRISMA } from '../../infra/tokens';
import { CurrentActor, RequirePermissions } from '../access/decorators';
import type { Actor } from '../auth/actor';

/**
 * Read-only view of how this deployment is configured (docs/OBSERVABILITY.md §6). Booleans and
 * labels only — never a secret, URL credential or key. Changing these is a deployment change
 * (environment variables), deliberately not something the dashboard can do.
 */
@ApiTags('System')
@ApiBearerAuth()
@Controller('v1/system')
export class SystemController {
  constructor(
    private readonly config: ApiConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  @Get('settings')
  @RequirePermissions('system.settings.manage')
  @ApiOperation({ summary: 'Platform: runtime configuration summary (no secrets)' })
  async settings(@CurrentActor() actor: Actor) {
    if (actor.organizationType !== 'PLATFORM') throw new AppError(ErrorCode.FORBIDDEN);
    const e = this.config.env;
    const [rules, enforcing, storageBackends] = await Promise.all([
      this.prisma.riskRule.count({ where: { enabled: true } }),
      this.prisma.riskRule.count({ where: { enabled: true, mode: 'ENFORCE' } }),
      this.prisma.storageBackend.count({ where: { isActive: true } }),
    ]);
    return {
      environment: e.NODE_ENV,
      api_environment: e.API_ENVIRONMENT,
      release: e.APP_RELEASE || null,
      security: {
        mfa_enforced_for_staff: e.AUTH_ENFORCE_MFA,
        session_idle_minutes: Math.round(e.AUTH_SESSION_IDLE_SECONDS / 60),
        max_failed_logins: e.AUTH_MAX_FAILED_LOGINS,
        webhook_https_required: e.WEBHOOK_REQUIRE_HTTPS,
        // A chosen storage backend encrypts every new file itself (docs/FILE_STORAGE.md §2).
        documents_encrypted_at_rest: storageBackends > 0 || Boolean(e.S3_SSE),
        swagger_ui_enabled: e.SWAGGER_ENABLED,
      },
      observability: {
        tracing: Boolean(e.OTEL_EXPORTER_OTLP_ENDPOINT),
        trace_sample_ratio: e.OTEL_TRACES_SAMPLE_RATIO,
        error_reporting: Boolean(e.SENTRY_DSN),
        metrics_port: e.METRICS_PORT || null,
        jobs_metrics_port: e.JOBS_METRICS_PORT || null,
        metrics_token_required: Boolean(e.METRICS_TOKEN),
      },
      messaging: { kafka_fast_path: e.KAFKA_BROKERS.length > 0 },
      risk: { enabled_rules: rules, enforcing_rules: enforcing },
    };
  }
}
