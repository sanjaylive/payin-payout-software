'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { Download, Loader2, Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FileDrop } from '@/components/common/file-drop';
import { api, apiDownload, apiUpload } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { MerchantApplication, MerchantDocument } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { DOCUMENT_LABELS } from './labels';
import { useInvalidateMerchant } from './use-merchant';

const MAX_MB = 10;

export function UploadDialog({ app, open, onOpenChange, fixedType }: { app: MerchantApplication; open: boolean; onOpenChange: (o: boolean) => void; fixedType?: string }) {
  const invalidate = useInvalidateMerchant(app.id);
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState(fixedType ?? '');
  const [personId, setPersonId] = useState('');
  const [busy, setBusy] = useState(false);
  // The same dialog is reused for different document types (onboarding checklist).
  const [shownFor, setShownFor] = useState(fixedType);
  if (shownFor !== fixedType) {
    setShownFor(fixedType);
    setType(fixedType ?? '');
    setPersonId('');
    setFile(null);
  }

  async function submit() {
    if (!file || !type) return;
    if (file.size > MAX_MB * 1024 * 1024) {
      toast.error(`File must be under ${MAX_MB} MB`);
      return;
    }
    const form = new FormData();
    form.set('type', type);
    if (personId) form.set('person_id', personId);
    form.set('file', file);
    setBusy(true);
    try {
      await apiUpload(`/v1/merchants/${app.id}/documents`, form);
      toast.success('Document uploaded');
      setFile(null);
      onOpenChange(false);
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{fixedType ? `Upload: ${DOCUMENT_LABELS[fixedType] ?? 'document'}` : 'Upload document'}</DialogTitle>
          <DialogDescription>PDF, PNG or JPEG up to {MAX_MB} MB. Files are checked by content and stored encrypted.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!fixedType && (
            <div className="space-y-1.5">
              <Label htmlFor="doc-type">Document type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="doc-type" className="w-full"><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>{Object.entries(DOCUMENT_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {type === 'DIRECTOR_KYC' && (
            <div className="space-y-1.5">
              <Label htmlFor="doc-person">Person</Label>
              <Select value={personId} onValueChange={setPersonId}>
                <SelectTrigger id="doc-person" className="w-full"><SelectValue placeholder="Whose KYC is this?" /></SelectTrigger>
                <SelectContent>{app.persons.map((p) => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <FileDrop file={file} onFile={setFile} accept="application/pdf,image/png,image/jpeg" hint={`PDF, PNG or JPEG · up to ${MAX_MB} MB`} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !type || !file || (type === 'DIRECTOR_KYC' && app.persons.length > 0 && !personId)} onClick={() => void submit()}>{busy ? <Loader2 className="animate-spin" /> : <Upload />} Upload</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewDialog({ merchantId, doc, onClose }: { merchantId: string; doc: MerchantDocument | null; onClose: () => void }) {
  const invalidate = useInvalidateMerchant(merchantId);
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  async function decide(status: 'VERIFIED' | 'REJECTED') {
    if (!doc) return;
    setBusy(true);
    try {
      await api.post(`/v1/merchants/${merchantId}/documents/${doc.id}/review`, { status, ...(reason ? { reason } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}) });
      toast.success(status === 'VERIFIED' ? 'Document verified' : 'Document rejected');
      setReason('');
      setExpiresAt('');
      onClose();
      await invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(doc)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review {doc ? DOCUMENT_LABELS[doc.type] : ''}</DialogTitle>
          <DialogDescription>{doc?.file_name} · sha256 {doc?.sha256.slice(0, 16)}…</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Button variant="outline" size="sm" onClick={() => doc && void apiDownload(`/v1/merchants/${merchantId}/documents/${doc.id}/content`, doc.file_name)}>
            <Download /> Open file
          </Button>
          <div className="space-y-1.5">
            <Label htmlFor="doc-expiry">Valid until (optional)</Label>
            <Input id="doc-expiry" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="doc-reason">Rejection reason (shown to the merchant)</Label>
            <Textarea id="doc-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy || reason.trim().length < 5} onClick={() => void decide('REJECTED')}>Reject</Button>
          <Button disabled={busy} onClick={() => void decide('VERIFIED')}>Verify</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DocumentsSection({
  app,
  canUpload,
  onlyType,
  excludeType,
  title = 'Documents',
  description,
}: {
  app: MerchantApplication;
  canUpload: boolean;
  onlyType?: string;
  excludeType?: string;
  title?: string;
  description?: string;
}) {
  const can = useCan();
  const [uploading, setUploading] = useState(false);
  const [reviewing, setReviewing] = useState<MerchantDocument | null>(null);
  const docs = app.documents.filter((d) => (!onlyType || d.type === onlyType) && d.type !== excludeType);
  const personName = (id: string | null) => app.persons.find((p) => p.id === id)?.full_name;

  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{description ?? 'Upload clear scans. Rejected documents show the reason so you can re-upload.'}</CardDescription>
        </div>
        {canUpload && <Button variant="outline" onClick={() => setUploading(true)}><Upload /> Upload</Button>}
      </CardHeader>
      <CardContent>
        <DataTable
          rows={docs}
          rowKey={(d) => d.id}
          empty={{ title: 'No documents uploaded' }}
          columns={[
            {
              id: 'type',
              header: 'Document',
              cell: (d) => (
                <div>
                  <p className="font-medium">{DOCUMENT_LABELS[d.type] ?? d.type}{personName(d.person_id) ? ` — ${personName(d.person_id)}` : ''}</p>
                  <p className="text-muted-foreground text-xs">{d.file_name} · {(d.size_bytes / 1024).toFixed(0)} KB</p>
                </div>
              ),
            },
            {
              id: 'status',
              header: 'Status',
              cell: (d) => (
                <div className="space-y-1">
                  <StatusBadge status={d.status} />
                  {d.rejection_reason && <p className="text-destructive max-w-xs text-xs">{d.rejection_reason}</p>}
                  {d.expires_at && <p className="text-muted-foreground text-xs">Valid until {d.expires_at}</p>}
                </div>
              ),
            },
            { id: 'uploaded', header: 'Uploaded', cell: (d) => <span className="text-muted-foreground text-sm">{formatDateTime(d.created_at)}</span> },
            {
              id: 'actions',
              header: '',
              align: 'right',
              cell: (d) => (
                <div className="flex justify-end gap-1">
                  {can('compliance.read') && (
                    <Button variant="ghost" size="icon" aria-label="Download" onClick={() => void apiDownload(`/v1/merchants/${app.id}/documents/${d.id}/content`, d.file_name).catch((e: unknown) => toast.error(errorMessage(e)))}>
                      <Download />
                    </Button>
                  )}
                  {can('compliance.approve') && d.status === 'UPLOADED' && <Button size="sm" onClick={() => setReviewing(d)}>Review</Button>}
                </div>
              ),
            },
          ]}
        />
      </CardContent>
      <UploadDialog app={app} open={uploading} onOpenChange={setUploading} fixedType={onlyType} />
      <ReviewDialog merchantId={app.id} doc={reviewing} onClose={() => setReviewing(null)} />
    </Card>
  );
}
