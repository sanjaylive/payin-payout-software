import type { OrganizationType } from '@pay2all/types';

export interface Me {
  user: { id: string; name: string; email: string; mobile: string | null; status: string; last_login_at: string | null; password_changed_at: string };
  organization: { id: string; name: string; type: OrganizationType; status: string };
  roles: string[];
  permissions: string[];
  session: { id: string; restricted: boolean };
  mfa: { enabled: boolean; required: boolean };
  memberships: { organization_id: string; organization_name: string; organization_type: OrganizationType; role_key: string; role_name: string }[];
}

export interface SessionTokens {
  status: 'AUTHENTICATED' | 'MFA_ENROLLMENT_REQUIRED' | 'MFA_REQUIRED';
  access_token?: string;
  mfa_token?: string;
  expires_in: number;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  type: OrganizationType;
  status: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  status: string;
  locked: boolean;
  last_login_at: string | null;
  created_at: string;
  memberships: { organization_id: string; organization_name: string; organization_type: OrganizationType; role_key: string; role_name: string; granted_at: string }[];
}

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string;
  scope: OrganizationType;
  is_system: boolean;
  requires_mfa: boolean;
  permissions: string[];
  member_count?: number;
}

export interface AuditLogRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  actor_role: string | null;
  organization_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  old_value: unknown;
  new_value: unknown;
  metadata: unknown;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  current: boolean;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  mfa_verified: boolean;
}
