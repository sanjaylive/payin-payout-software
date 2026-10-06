'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { EmptyState, ErrorState, LoadingSkeleton } from './states';
import { Button } from './ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: 'left' | 'right';
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: { message: string; requestId?: string } | null;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  empty?: { title: string; description?: string; action?: ReactNode };
  /** Server-side keyset pagination: the parent owns the cursor stack. */
  pagination?: { hasPrevious: boolean; hasNext: boolean; onPrevious: () => void; onNext: () => void; pageLabel?: string };
  toolbar?: ReactNode;
}

/**
 * Server-driven table. Never holds the full dataset — rows are one page returned by the API, and
 * filtering/sorting/pagination happen server-side (docs/ARCHITECTURE.md §10).
 */
export function DataTable<T>({ columns, rows, rowKey, loading, error, onRetry, onRowClick, empty, pagination, toolbar }: DataTableProps<T>) {
  return (
    <div className="bg-card overflow-hidden rounded-lg border">
      {toolbar && <div className="flex flex-wrap items-center gap-2 border-b p-3">{toolbar}</div>}
      {error ? (
        <ErrorState message={error.message} requestId={error.requestId} onRetry={onRetry} />
      ) : loading && !rows ? (
        <LoadingSkeleton />
      ) : !rows?.length ? (
        <EmptyState title={empty?.title ?? 'No records found'} description={empty?.description} action={empty?.action} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              {columns.map((c) => (
                <TableHead
                  key={c.id}
                  className={cn('text-muted-foreground h-10 text-xs font-medium tracking-wide uppercase', c.align === 'right' && 'text-right', c.className)}
                >
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody className={cn(loading && 'opacity-60')}>
            {rows.map((row) => (
              <TableRow
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(onRowClick && 'cursor-pointer')}
              >
                {columns.map((c) => (
                  <TableCell key={c.id} className={cn('py-3', c.align === 'right' && 'text-right', c.className)}>
                    {c.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {pagination && (rows?.length ?? 0) > 0 && (
        <div className="flex items-center justify-between border-t px-3 py-2">
          <span className="text-muted-foreground text-xs">{pagination.pageLabel}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={!pagination.hasPrevious || loading} onClick={pagination.onPrevious}>
              <ChevronLeft /> Previous
            </Button>
            <Button variant="outline" size="sm" disabled={!pagination.hasNext || loading} onClick={pagination.onNext}>
              Next <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
