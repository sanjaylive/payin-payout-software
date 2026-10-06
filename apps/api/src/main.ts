import 'reflect-metadata';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { ApiConfig } from './config/api-config';
import { createApp } from './app.factory';

async function bootstrap(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    // Local development convenience: load the monorepo root .env. Production injects real env vars.
    loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  }
  const config = ApiConfig.fromProcessEnv();
  const app = await createApp(config);
  await app.listen(config.env.PORT);
}

bootstrap().catch((err: unknown) => {
  // Logger may not exist yet (e.g. env validation failed) — write a single structured line.
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'API failed to start', error: err instanceof Error ? err.message : String(err) })}\n`,
  );
  process.exit(1);
});
