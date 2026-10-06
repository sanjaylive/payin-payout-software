import { ProviderError } from './interfaces/errors';
import type { PayinProvider, PayoutProvider, ProviderContext } from './interfaces/types';
import { MockPayinProvider } from './mock/payin';
import { MockPayoutProvider } from './mock/payout';
import { ProviderAAdapter } from './provider-a';
import { ProviderBAdapter } from './provider-b';

interface AdapterFactory {
  label: string;
  /** Credential keys the adapter needs (shown in the admin UI; values are write-only). */
  credentialKeys: string[];
  payin?: (ctx: ProviderContext) => PayinProvider;
  payout?: (ctx: ProviderContext) => PayoutProvider;
}

export const ADAPTERS: Record<string, AdapterFactory> = {
  mock: {
    label: 'Sandbox (mock)',
    credentialKeys: ['webhook_secret'],
    payin: (ctx) => new MockPayinProvider(ctx),
    payout: (ctx) => new MockPayoutProvider(ctx),
  },
  'provider-a': {
    label: 'Provider A (template: signed REST PSP)',
    credentialKeys: ['api_key', 'api_secret', 'webhook_secret'],
    payin: (ctx) => new ProviderAAdapter(ctx),
    payout: (ctx) => new ProviderAAdapter(ctx),
  },
  'provider-b': {
    label: 'Provider B (template: bank payout API)',
    credentialKeys: ['access_token', 'webhook_secret'],
    payout: (ctx) => new ProviderBAdapter(ctx),
  },
};

export function payinAdapter(adapter: string, ctx: ProviderContext): PayinProvider {
  const factory = ADAPTERS[adapter]?.payin;
  if (!factory) throw new ProviderError('CONFIGURATION', 'NO_PAYIN_ADAPTER', `Adapter "${adapter}" does not support payins`, ctx.providerCode);
  return factory(ctx);
}

export function payoutAdapter(adapter: string, ctx: ProviderContext): PayoutProvider {
  const factory = ADAPTERS[adapter]?.payout;
  if (!factory) throw new ProviderError('CONFIGURATION', 'NO_PAYOUT_ADAPTER', `Adapter "${adapter}" does not support payouts`, ctx.providerCode);
  return factory(ctx);
}
