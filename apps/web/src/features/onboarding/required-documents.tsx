'use client';

import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { cn } from '@pay2all/ui/lib/utils';
import { CircleCheck, CircleDashed, CircleAlert, Upload } from 'lucide-react';
import { useState } from 'react';
import type { MerchantApplication, MerchantDocument } from '@/lib/api/types';
import { UploadDialog } from '../merchants/documents-section';
import { DOCUMENT_LABELS } from '../merchants/labels';

const HINTS: Record<string, string> = {
  PAN: 'PAN card of the business (or the proprietor, for a proprietorship).',
  ADDRESS_PROOF: 'Utility bill, rent agreement or GST certificate showing the business address.',
  CANCELLED_CHEQUE: 'A cancelled cheque of the settlement account, with the business name printed.',
  BANK_PROOF: 'A recent bank statement of the settlement account.',
  DIRECTOR_KYC: 'Aadhaar, passport or voter ID of each director, partner or proprietor.',
  GST_CERTIFICATE: 'GST registration certificate (form REG-06).',
  CIN_CERTIFICATE: 'Certificate of incorporation issued by the MCA.',
  AGREEMENT: 'The merchant agreement, signed by an authorised signatory.',
};

/** Latest document of any of these types; null when none is uploaded. */
function latest(docs: MerchantDocument[], types: string[]): MerchantDocument | null {
  return docs.filter((d) => types.includes(d.type)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

/** The documents this application needs (from the server's requirements), each with its own upload. */
export function RequiredDocuments({ app, canUpload }: { app: MerchantApplication; canUpload: boolean }) {
  const [uploading, setUploading] = useState<string | null>(null);
  const groups = app.requirements
    .filter((r) => r.stage === 'SUBMISSION' && r.key.startsWith('documents.') && r.key.endsWith('.uploaded'))
    .map((r) => ({ key: r.key, satisfied: r.satisfied, types: r.key.slice('documents.'.length, -'.uploaded'.length).split('|') }));

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-xl border">
        {groups.map((g) => {
          const doc = latest(app.documents, g.types);
          const rejected = doc?.status === 'REJECTED';
          return (
            <li key={g.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-full',
                  g.satisfied ? 'bg-success-muted text-success' : rejected ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
                )}
              >
                {g.satisfied ? <CircleCheck className="size-5" /> : rejected ? <CircleAlert className="size-5" /> : <CircleDashed className="size-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{g.types.map((t) => DOCUMENT_LABELS[t] ?? t).join(' or ')}</p>
                <p className="text-muted-foreground text-xs">{HINTS[g.types[0]!] ?? ''}</p>
                {doc && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                    <StatusBadge status={doc.status} />
                    <span className="text-muted-foreground truncate">{doc.file_name}</span>
                  </div>
                )}
                {rejected && doc.rejection_reason && <p className="text-destructive mt-1 text-xs">{doc.rejection_reason}</p>}
              </div>
              {canUpload && (
                <div className="flex shrink-0 flex-wrap gap-2">
                  {g.types.map((t) => (
                    <Button key={t} size="sm" variant={g.satisfied ? 'outline' : 'default'} onClick={() => setUploading(t)}>
                      <Upload /> {g.types.length > 1 ? (DOCUMENT_LABELS[t] ?? t) : doc ? 'Replace' : 'Upload'}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <UploadDialog app={app} open={Boolean(uploading)} onOpenChange={(o) => !o && setUploading(null)} fixedType={uploading ?? undefined} />
    </div>
  );
}
