'use client';

import { TransactionDetailsDrawer } from '@pay2all/ui/components/details-drawer';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { formatDateTime } from '@pay2all/ui/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CopyButton } from '@/features/funds/shared';
import { api, API_URL } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { DeliveryStats, EmailSuppressionRow, MessagingChannel, MessagingNotification, MessagingServiceRow } from '@/lib/api/types';
import { ADAPTER_LABELS, CHANNEL_ADAPTERS, CONFIG_FIELDS, type FieldSpec, SECRET_FIELDS, SERVICE_LABELS } from './labels';

type Adapter = 'ses' | 'smtp' | 'sms21';
type TemplateRow = { key: string; template_id: string; variables: string };

function FieldInput({ f, value, onChange }: { f: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  if (f.kind === 'bool') {
    return (
      <div className="flex items-center justify-between rounded-md border p-3 sm:col-span-2">
        <span className="text-sm">{f.label}</span>
        <Switch checked={value === true} onCheckedChange={onChange} aria-label={f.label} />
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`f-${f.key}`}>{f.label}{f.optional ? <span className="text-muted-foreground"> (optional)</span> : null}</Label>
      <Input
        id={`f-${f.key}`}
        type={f.kind === 'password' ? 'password' : 'text'}
        inputMode={f.kind === 'number' ? 'numeric' : undefined}
        autoComplete="off"
        placeholder={f.placeholder}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
      {f.hint && <p className="text-muted-foreground text-[11px]">{f.hint}</p>}
    </div>
  );
}

function toConfig(adapter: Adapter, values: Record<string, unknown>, templates: TemplateRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of CONFIG_FIELDS[adapter]) {
    const v = values[f.key];
    if (f.kind === 'bool') out[f.key] = v === true;
    else if (v !== undefined && v !== '') out[f.key] = f.kind === 'number' ? Number(v) : String(v).trim();
  }
  if (adapter === 'sms21') {
    out.templates = Object.fromEntries(
      templates.filter((t) => t.key.trim() && t.template_id.trim()).map((t) => [t.key.trim(), { template_id: t.template_id.trim(), variables: t.variables.split(',').map((x) => x.trim()).filter(Boolean) }]),
    );
  }
  return out;
}

function templatesOf(config: Record<string, unknown>): TemplateRow[] {
  const t = (config.templates ?? {}) as Record<string, { template_id: string; variables?: string[] }>;
  return Object.entries(t).map(([key, v]) => ({ key, template_id: v.template_id, variables: (v.variables ?? []).join(', ') }));
}

function TemplatesEditor({ rows, onChange, channel }: { rows: TemplateRow[]; onChange: (r: TemplateRow[]) => void; channel: MessagingChannel }) {
  const set = (i: number, patch: Partial<TemplateRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2 sm:col-span-2">
      <Label>Templates</Label>
      <p className="text-muted-foreground text-[11px]">
        Map each Pay2All message (e.g. <span className="font-mono">payout_alert</span>, <span className="font-mono">test</span>) to its approved {channel === 'SMS' ? 'DLT SMS template (tmpl_…)' : 'WhatsApp template (wtpl_…)'} in sms21, and the variable names it expects. Messages without a template are sent as free text, which {channel === 'SMS' ? 'only works with test keys in India' : 'WhatsApp only delivers within 24 h of the customer’s last message'}.
      </p>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1.3fr_1.3fr_auto] gap-2">
          <Input aria-label="Message key" className="font-mono text-xs" placeholder="payout_alert" value={r.key} onChange={(e) => set(i, { key: e.target.value })} />
          <Input aria-label="Template ID" className="font-mono text-xs" placeholder={channel === 'SMS' ? 'tmpl_…' : 'wtpl_…'} value={r.template_id} onChange={(e) => set(i, { template_id: e.target.value })} />
          <Input aria-label="Variables" className="text-xs" placeholder="amount, utr" value={r.variables} onChange={(e) => set(i, { variables: e.target.value })} />
          <Button size="icon" variant="ghost" aria-label="Remove template" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 /></Button>
        </div>
      ))}
      <Button size="sm" variant="outline" onClick={() => onChange([...rows, { key: '', template_id: '', variables: '' }])}><Plus /> Add template</Button>
    </div>
  );
}

/** Create (vendorId) or edit (service) a messaging service. */
export function MessagingServiceDialog({ vendorId, service, open, onClose }: { vendorId: string; service: MessagingServiceRow | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [channel, setChannel] = useState<MessagingChannel>(service?.channel ?? 'SMS');
  const [adapter, setAdapter] = useState<Adapter>(service?.adapter ?? 'sms21');
  const [name, setName] = useState(service?.name ?? '');
  const [priority, setPriority] = useState(String(service?.priority ?? 100));
  const [status, setStatus] = useState(service?.status ?? 'DISABLED');
  const [values, setValues] = useState<Record<string, unknown>>(service?.config ?? {});
  const [templates, setTemplates] = useState<TemplateRow[]>(service ? templatesOf(service.config) : []);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const adapters = CHANNEL_ADAPTERS[channel];
  const effAdapter = adapters.includes(adapter) ? adapter : adapters[0]!;
  const valid = name.trim().length >= 2 && /^\d{1,4}$/.test(priority) && (!service || reason.trim().length >= 5);

  async function submit() {
    setBusy(true);
    try {
      const config = toConfig(effAdapter, values, templates);
      if (service) await api.patch(`/v1/messaging-services/${service.service_id}`, { name: name.trim(), priority: Number(priority), status, config, reason: reason.trim() });
      else await api.post(`/v1/vendors/${vendorId}/messaging-services`, { channel, adapter: effAdapter, name: name.trim(), priority: Number(priority), config });
      await qc.invalidateQueries({ queryKey: ['vendor', vendorId] });
      toast.success(service ? 'Service updated' : 'Service added — set its credentials, send a test, then switch it on');
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{service ? `Edit ${service.name}` : 'Add messaging service'}</DialogTitle>
          <DialogDescription>Within a channel, active services are tried in priority order (lowest first); the next one is the fallback.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {!service && (
            <>
              <div className="space-y-1.5">
                <Label>Channel</Label>
                <Select value={channel} onValueChange={(v) => { setChannel(v as MessagingChannel); setValues({}); setTemplates([]); }}>
                  <SelectTrigger aria-label="Channel"><SelectValue /></SelectTrigger>
                  <SelectContent>{(['SMS', 'WHATSAPP', 'EMAIL'] as const).map((c) => <SelectItem key={c} value={c}>{SERVICE_LABELS[c]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Integration</Label>
                <Select value={effAdapter} onValueChange={(v) => { setAdapter(v as Adapter); setValues({}); }}>
                  <SelectTrigger aria-label="Integration"><SelectValue /></SelectTrigger>
                  <SelectContent>{adapters.map((a) => <SelectItem key={a} value={a}>{ADAPTER_LABELS[a]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </>
          )}
          <div className="space-y-1.5"><Label htmlFor="ms-name">Name</Label><Input id="ms-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`${ADAPTER_LABELS[effAdapter]} ${SERVICE_LABELS[channel]}`} /></div>
          <div className="space-y-1.5"><Label htmlFor="ms-prio">Priority</Label><Input id="ms-prio" inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value.trim())} /></div>
          {CONFIG_FIELDS[effAdapter].map((f) => <FieldInput key={f.key} f={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />)}
          {effAdapter === 'sms21' && <TemplatesEditor rows={templates} onChange={setTemplates} channel={channel} />}
          {service && (
            <>
              <div className="flex items-center justify-between rounded-md border p-3 sm:col-span-2">
                <div><p className="text-sm font-medium">Active</p><p className="text-muted-foreground text-xs">Send real notifications through this service.</p></div>
                <Switch checked={status === 'ACTIVE'} onCheckedChange={(c) => setStatus(c ? 'ACTIVE' : 'DISABLED')} aria-label="Active" />
              </div>
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="ms-reason">Reason for change (audited)</Label><Input id="ms-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} {service ? 'Save' : 'Add service'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CredentialsDialog({ service, onClose }: { service: MessagingServiceRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const fields = service ? SECRET_FIELDS[service.adapter] : [];
  // With stored credentials, a blank field keeps its saved value; the first save needs every required field.
  const hasStored = Boolean(service?.has_secret);
  const filled = (k: string) => String(values[k] ?? '').trim().length > 0;
  const valid = fields.some((f) => filled(f.key)) && (hasStored || fields.every((f) => f.optional || filled(f.key)));
  async function submit() {
    if (!service) return;
    setBusy(true);
    try {
      await api.put(`/v1/messaging-services/${service.service_id}/credentials`, { secret: Object.fromEntries(fields.filter((f) => filled(f.key)).map((f) => [f.key, String(values[f.key]).trim()])) });
      await qc.invalidateQueries({ queryKey: ['vendor', service.vendor_id] });
      toast.success('Credentials saved');
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(service)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Credentials · {service?.name}</DialogTitle>
          <DialogDescription>Encrypted as soon as they’re saved and never shown again — only replaced. {hasStored ? 'Leave a field blank to keep its saved value.' : ''}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">{fields.map((f) => <FieldInput key={f.key} f={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />)}</div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Save credentials</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TestMessageDialog({ service, onClose }: { service: MessagingServiceRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const email = service?.channel === 'EMAIL';
  async function submit() {
    if (!service) return;
    setBusy(true);
    try {
      await api.post(`/v1/messaging-services/${service.service_id}/test`, { to: to.trim() });
      toast.success('Test queued — check the recipient and the recent messages list');
      await qc.invalidateQueries({ queryKey: ['messaging-notifications', service.service_id] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(service)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a test · {service?.name}</DialogTitle>
          <DialogDescription>Goes through this service only, even while it’s switched off. {service?.channel === 'SMS' ? 'Map a "test" template for live keys (DLT).' : service?.channel === 'WHATSAPP' ? 'Without a "test" template, WhatsApp only delivers if the number messaged you in the last 24 h.' : ''}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="t-to">{email ? 'Email address' : 'Mobile (international format)'}</Label>
          <Input id="t-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder={email ? 'you@yourdomain.in' : '+919876543210'} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={to.trim().length < 5 || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Send test</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DELIVERY_TONE: Record<NonNullable<MessagingNotification['delivery_status']>, string> = {
  SENT: 'text-muted-foreground',
  DELIVERED: 'text-emerald-600',
  FAILED: 'text-destructive',
  EXPIRED: 'text-amber-600',
  BOUNCED: 'text-destructive',
  COMPLAINED: 'text-destructive',
};

/** Where this service's vendor should post delivery receipts (docs/VENDORS.md §3). */
function receiptUrl(service: MessagingServiceRow) {
  const base = API_URL.replace(/\/$/, '');
  if (service.adapter === 'sms21') return { url: `${base}/v1/webhooks/messaging/sms21/${service.service_id}`, how: 'In sms21 → Developers → Webhooks, add this URL for message events and save its signing secret (whsec_…) in this service’s credentials.' };
  if (service.adapter === 'ses') return { url: `${base}/v1/webhooks/messaging/ses/${service.service_id}`, how: 'Create an SNS topic for SES delivery, bounce and complaint events, subscribe this URL (HTTPS), and enter the topic ARN in this service’s settings. The subscription is confirmed automatically.' };
  return null;
}

export function RecentMessagesDrawer({ service, onClose }: { service: MessagingServiceRow | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['messaging-notifications', service?.service_id],
    queryFn: () => api.get<MessagingNotification[]>(`/v1/messaging-services/${service!.service_id}/notifications`),
    enabled: Boolean(service),
    refetchInterval: 5_000,
  });
  const stats = useQuery({ queryKey: ['messaging-delivery', service?.service_id], queryFn: () => api.get<DeliveryStats>(`/v1/messaging/services/${service!.service_id}/delivery`), enabled: Boolean(service) });
  const receipts = service ? receiptUrl(service) : null;
  const s = stats.data;
  const delivered = s && s.sent ? Math.round(((s.DELIVERED ?? 0) / s.sent) * 100) : null;
  return (
    <TransactionDetailsDrawer open={Boolean(service)} onOpenChange={(o) => !o && onClose()} title={service?.name ?? ''} subtitle="Last 20 messages through this service" sections={[]}>
      {s && s.sent > 0 && (
        <div className="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-lg border p-2"><p className="text-lg font-semibold">{delivered ?? '—'}%</p><p className="text-muted-foreground">delivered (7 days)</p></div>
          <div className="rounded-lg border p-2"><p className="text-lg font-semibold">{(s.FAILED ?? 0) + (s.BOUNCED ?? 0) + (s.EXPIRED ?? 0)}</p><p className="text-muted-foreground">failed / bounced</p></div>
          <div className="rounded-lg border p-2"><p className="text-lg font-semibold">{s.NO_RECEIPT ?? 0}</p><p className="text-muted-foreground">no receipt yet</p></div>
        </div>
      )}
      {receipts && (
        <div className="bg-muted/40 mb-3 space-y-1 rounded-lg border p-3 text-xs">
          <p className="font-medium">Delivery receipts</p>
          <div className="flex items-center gap-1"><code className="min-w-0 flex-1 truncate">{receipts.url}</code><CopyButton value={receipts.url} label="Receipt URL" /></div>
          <p className="text-muted-foreground">{receipts.how}</p>
        </div>
      )}
      {q.data?.length === 0 && <p className="text-muted-foreground text-sm">No messages yet. Send a test.</p>}
      <ul className="divide-y rounded-lg border text-sm">
        {q.data?.map((n) => (
          <li key={n.notification_id} className="space-y-1 px-3 py-2">
            <div className="flex items-center justify-between gap-2"><span className="font-mono text-xs">{n.recipient} · {n.template}</span><StatusBadge status={n.status} /></div>
            <p className="text-muted-foreground text-xs">{formatDateTime(n.created_at)}{n.provider_message_id ? ` · ${n.provider_message_id}` : ''}{n.attempts > 1 ? ` · ${n.attempts} attempts` : ''}</p>
            {n.delivery_status && (
              <p className={`text-xs font-medium ${DELIVERY_TONE[n.delivery_status]}`}>
                {n.delivery_status.charAt(0) + n.delivery_status.slice(1).toLowerCase()}
                {n.delivery_at ? ` · ${formatDateTime(n.delivery_at)}` : ''}
                {n.delivery_detail ? ` · ${n.delivery_detail}` : ''}
              </p>
            )}
            {n.error && <p className="text-destructive text-xs break-all">{n.error}</p>}
          </li>
        ))}
      </ul>
    </TransactionDetailsDrawer>
  );
}

/** Settings → API Vendors: addresses we stopped emailing (masked), with an undo for fixed mailboxes. */
export function EmailSuppressions() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['email-suppressions'], queryFn: () => api.get<EmailSuppressionRow[]>('/v1/messaging/suppressions') });
  const rows = q.data ?? [];
  if (!rows.length) return null;
  return (
    <div className="space-y-2 rounded-xl border p-4">
      <p className="text-sm font-semibold">Suppressed email addresses</p>
      <p className="text-muted-foreground text-xs">After a hard bounce or a spam complaint, the platform stops emailing an address. Remove one only after the mailbox is fixed.</p>
      <ul className="divide-y text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="font-mono text-xs">{r.email}</p>
              <p className="text-muted-foreground truncate text-xs">{r.reason.toLowerCase()} · {formatDateTime(r.created_at)}{r.detail ? ` · ${r.detail}` : ''}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void api
                  .delete(`/v1/messaging/suppressions/${r.id}`)
                  .then(() => {
                    toast.success('Address can receive email again');
                    return qc.invalidateQueries({ queryKey: ['email-suppressions'] });
                  })
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
