/**
 * @pay2all/providers — provider contracts, error taxonomy, routing engine, failover executor,
 * health tracking and adapters (mock, provider-a, provider-b). See docs/ARCHITECTURE.md §9.
 */
export * from './health/health';
export * from './http/client';
export * from './interfaces/errors';
export * from './interfaces/types';
export { MockPayinProvider } from './mock/payin';
export { MockPayoutProvider } from './mock/payout';
export { ulidTime } from './mock/shared';
export { ProviderAAdapter } from './provider-a';
export { ProviderBAdapter } from './provider-b';
export * from './gateways/catalog';
export { ccavDecrypt, ccavEncrypt } from './gateways/ccavenue';
export { atomDecrypt, atomEncrypt } from './gateways/nttdata';
export * from './registry';
export * from './routing/engine';
export * from './routing/failover';
