// Must be first: tracing patches http/pg/ioredis/kafkajs/pino as they are loaded.
import './instrument.jobs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { initMetrics, registry, startMetricsServer } from '@pay2all/telemetry';
import { Logger } from 'nestjs-pino';
import { ApiConfig } from './config/api-config';
import { JobsModule } from './jobs/jobs.module';
import { JobsRunner } from './jobs/jobs.runner';

/** Entry point for the API's domain jobs process (no HTTP server). */
async function bootstrap(): Promise<void> {
  const config = ApiConfig.fromProcessEnv();
  initMetrics('jobs');
  const app = await NestFactory.createApplicationContext(JobsModule.register(config), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.get(JobsRunner).start();
  if (config.env.JOBS_METRICS_PORT) {
    const server = await startMetricsServer({ port: config.env.JOBS_METRICS_PORT, host: config.env.METRICS_HOST, registry, token: config.env.METRICS_TOKEN || undefined });
    process.once('SIGTERM', () => server.close());
  }
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: 'Jobs failed to start', error: err instanceof Error ? err.message : String(err) })}\n`);
  process.exit(1);
});
