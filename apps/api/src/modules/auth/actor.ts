import type { PermissionKey } from '@pay2all/auth';
import type { OrganizationType } from '@pay2all/types';

/** Authenticated principal for a dashboard request. Built only from server-side session state. */
export interface Actor {
  kind: 'user';
  userId: string;
  sessionId: string;
  /** Active organization of the session — the tenant context. Never taken from request input. */
  organizationId: string;
  organizationType: OrganizationType;
  /** Parent org (reseller/platform) of the active organization. */
  organizationParentId: string | null;
  roleKeys: readonly string[];
  permissions: ReadonlySet<PermissionKey>;
  /** Session restricted to MFA enrollment (privileged role without TOTP). */
  restricted: boolean;
}
