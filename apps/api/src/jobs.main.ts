import 'reflect-metadata';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import { Logger } from 'nestjs-pino';
import { ApiConfig } from './config/api-config';
import { JobsModule } from './jobs/jobs.module';
import { JobsRunner } from './jobs/jobs.runner';

/** Entry point for the API's domain jobs process (no HTTP server). */
async function bootstrap(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  }
  const config = ApiConfig.fromProcessEnv();
  const app = await NestFactory.createApplicationContext(JobsModule.register(config), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.get(JobsRunner).start();
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: 'Jobs failed to start', error: err instanceof Error ? err.message : String(err) })}\n`);
  process.exit(1);
});
