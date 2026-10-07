import path from 'node:path';
import { initErrorReporting } from '@pay2all/telemetry';
import { initTracing } from '@pay2all/telemetry/tracing';
import { config as loadDotenv } from 'dotenv';

/**
 * Process-level instrumentation (docs/OBSERVABILITY.md). Imported before anything else by each
 * entry point so OpenTelemetry can patch http/pg/ioredis/kafkajs/pino as they load. Reads raw env
 * (full validation happens later in ApiConfig); both features are off when their settings are empty.
 */
export function startInstrumentation(service: 'api' | 'jobs'): void {
  if (process.env.NODE_ENV !== 'production') loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  const env = process.env;
  const ratio = Number(env.OTEL_TRACES_SAMPLE_RATIO ?? '0.1');
  initTracing({
    service,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    sampleRatio: Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 0.1,
    environment: env.NODE_ENV ?? 'development',
    version: env.APP_RELEASE || undefined,
  });
  initErrorReporting({ dsn: env.SENTRY_DSN || undefined, service, environment: env.NODE_ENV ?? 'development', release: env.APP_RELEASE || undefined });
}
