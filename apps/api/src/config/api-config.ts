import { type ApiEnv, apiEnvSchema, loadEnv } from '@pay2all/config';

/** Typed, validated configuration. Injected everywhere instead of reading process.env directly. */
export class ApiConfig {
  constructor(readonly env: ApiEnv) {}

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  static fromProcessEnv(): ApiConfig {
    return new ApiConfig(loadEnv(apiEnvSchema));
  }
}
