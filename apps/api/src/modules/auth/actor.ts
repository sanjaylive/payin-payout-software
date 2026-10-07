import type { PermissionKey } from '@pay2all/auth';
import type { OrganizationType } from '@pay2all/types';

/**
 * Authenticated principal. Built only from server-side state: a dashboard session, or a verified API
 * key signature. For API keys `userId` is the key id (so `created_by` and audit name the key) and
 * `sessionId` is a sentinel — keys can never satisfy MFA-gated actions such as approvals.
 */
export interface Actor {
  kind: 'user' | 'api_key';
  userId: string;
  /** Set for API-key actors. */
  apiKeyId?: string;
  /** API partner organization when a partner key acts for one of its merchants. */
  partnerOrganizationId?: string;
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
