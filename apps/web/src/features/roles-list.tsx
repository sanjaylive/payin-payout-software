'use client';

import { ErrorState, LoadingSkeleton } from '@pay2all/ui/components/states';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Badge } from '@pay2all/ui/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { RoleRow } from '@/lib/api/types';

const SCOPE_ORDER = ['PLATFORM', 'RESELLER', 'API_PARTNER', 'MERCHANT'];

/** Roles grouped by organization scope with their permission sets (read-only in Phase 1). */
export function RolesList() {
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/v1/roles') });
  if (roles.isPending) return <LoadingSkeleton />;
  if (roles.isError) return <ErrorState message={errorMessage(roles.error)} onRetry={() => void roles.refetch()} />;

  return (
    <div className="space-y-8">
      {SCOPE_ORDER.filter((s) => roles.data.some((r) => r.scope === s)).map((scope) => (
        <section key={scope}>
          <h2 className="text-muted-foreground mb-3 text-xs font-semibold tracking-wide uppercase">{scope.replace('_', ' ')} roles</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {roles.data
              .filter((r) => r.scope === scope)
              .map((r) => (
                <Card key={r.id} className="gap-3 shadow-none">
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-base">{r.name}</CardTitle>
                      <div className="flex gap-1.5">
                        {r.requires_mfa && <StatusBadge status="MFA REQUIRED" tone="primary" />}
                        {r.member_count !== undefined && <Badge variant="outline">{r.member_count} members</Badge>}
                      </div>
                    </div>
                    <CardDescription>{r.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-1">
                    {r.permissions.map((p) => (
                      <code key={p} className="bg-muted rounded px-1.5 py-0.5 text-[11px]">{p}</code>
                    ))}
                  </CardContent>
                </Card>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
