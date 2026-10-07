import path from 'node:path';
import { initErrorReporting } from '@pay2all/telemetry';
import { initTracing } from '@pay2all/telemetry/tracing';
import { config as loadDotenv } from 'dotenv';

// Imported first by main.ts so OpenTelemetry can patch pg/ioredis/kafkajs/http/pino as they load.
if (process.env.NODE_ENV !== 'production') loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
const ratio = Number(process.env.OTEL_TRACES_SAMPLE_RATIO ?? '0.1');
initTracing({
  service: 'worker',
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
  sampleRatio: Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 0.1,
  environment: process.env.NODE_ENV ?? 'development',
  version: process.env.APP_RELEASE || undefined,
});
initErrorReporting({ dsn: process.env.SENTRY_DSN || undefined, service: 'worker', environment: process.env.NODE_ENV ?? 'development', release: process.env.APP_RELEASE || undefined });
