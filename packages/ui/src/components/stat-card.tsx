import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Card, CardContent } from './ui/card';
import { Skeleton } from './ui/skeleton';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  hint?: ReactNode;
  trend?: { direction: 'up' | 'down' | 'flat'; label: string };
  loading?: boolean;
  className?: string;
}

export function StatCard({ label, value, icon: Icon, hint, trend, loading, className }: StatCardProps) {
  return (
    <Card className={cn('gap-0 py-5 shadow-none', className)}>
      <CardContent className="px-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-muted-foreground text-sm font-medium">{label}</p>
          {Icon && (
            <span className="bg-accent text-accent-foreground grid size-8 shrink-0 place-items-center rounded-md">
              <Icon className="size-4" aria-hidden />
            </span>
          )}
        </div>
        <div className="mt-2 text-2xl font-semibold tracking-tight">
          {loading ? <Skeleton className="h-8 w-32" /> : value}
        </div>
        {(hint || trend) && (
          <div className="mt-1.5 flex items-center gap-2 text-xs">
            {trend && (
              <span
                className={cn(
                  'font-medium',
                  trend.direction === 'up' && 'text-success',
                  trend.direction === 'down' && 'text-destructive',
                  trend.direction === 'flat' && 'text-muted-foreground',
                )}
              >
                {trend.label}
              </span>
            )}
            {hint && <span className="text-muted-foreground">{hint}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
