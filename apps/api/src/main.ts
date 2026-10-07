// Must be first: tracing patches http/pg/ioredis/kafkajs/pino as they are loaded.
import './instrument.api';
import 'reflect-metadata';
import { initMetrics, registry, startMetricsServer } from '@pay2all/telemetry';
import { ApiConfig } from './config/api-config';
import { createApp } from './app.factory';

async function bootstrap(): Promise<void> {
  // instrument.api already loaded the monorepo root .env outside production.
  const config = ApiConfig.fromProcessEnv();
  initMetrics('api');
  const app = await createApp(config);
  await app.listen(config.env.PORT);
  if (config.env.METRICS_PORT) {
    const server = await startMetricsServer({ port: config.env.METRICS_PORT, host: config.env.METRICS_HOST, registry, token: config.env.METRICS_TOKEN || undefined });
    process.once('SIGTERM', () => server.close());
  }
}

bootstrap().catch((err: unknown) => {
  // Logger may not exist yet (e.g. env validation failed) — write a single structured line.
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'API failed to start', error: err instanceof Error ? err.message : String(err) })}\n`,
  );
  process.exit(1);
});
