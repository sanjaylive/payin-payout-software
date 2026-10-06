import { AsyncLocalStorage } from 'node:async_hooks';
import type { Actor } from '../../modules/auth/actor';

/**
 * Per-request context propagated via AsyncLocalStorage. Available to services, audit logging and
 * the logger without threading parameters through every call.
 */
export interface RequestContext {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
  actor?: Actor;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const RequestContextStore = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  /** Throws if called outside a request — use only in request-scoped code paths. */
  require(): RequestContext {
    const ctx = storage.getStore();
    if (!ctx) throw new Error('RequestContext accessed outside of a request');
    return ctx;
  },
  setActor(actor: Actor): void {
    const ctx = storage.getStore();
    if (ctx) ctx.actor = actor;
  },
};
