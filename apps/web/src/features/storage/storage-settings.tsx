'use client';

import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@pay2all/ui/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatRelative } from '@pay2all/ui/lib/format';
import { cn } from '@pay2all/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Cloud, Copy, FileKey2, FolderOpen, HardDrive, Loader2, Lock, PlugZap, Server, ShieldCheck, Trash2, Upload, XCircle } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { StorageBackendRow, StorageCheck, StorageKind, StorageOverview } from '@/lib/api/types';

type Choice = StorageKind | 'DEFAULT';
const KEY = ['storage-backends'];

const META: Record<Choice, { label: string; icon: typeof Cloud; blurb: string }> = {
  DEFAULT: { label: 'Server default', icon: Server, blurb: 'The S3 bucket set in the server’s environment' },
  S3: { label: 'Amazon S3', icon: Cloud, blurb: 'AWS S3 or S3-compatible (R2, MinIO)' },
  GOOGLE_DRIVE: { label: 'Google Drive', icon: FolderOpen, blurb: 'A Shared Drive folder, via a service account' },
  LOCAL: { label: 'Local disk', icon: HardDrive, blurb: 'A folder on this server' },
};

const LOCKED: Record<StorageKind, string[]> = {
  S3: ['bucket', 'region', 'endpoint', 'prefix', 'force_path_style'],
  GOOGLE_DRIVE: ['folder_id'],
  LOCAL: ['directory'],
};

function formatBytes(raw: string | number): string {
  let n = Number(raw);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error('Could not copy'),
  );
}

function stateOf(b: StorageBackendRow | undefined, active: Choice, kind: Choice): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' } {
  if (kind === active) return { label: 'In use', tone: 'success' };
  if (kind === 'DEFAULT') return { label: 'Available', tone: 'neutral' };
  if (!b?.configured) return { label: 'Not set up', tone: 'neutral' };
  if (b.last_test?.ok === false) return { label: 'Test failed', tone: 'danger' };
  if (b.last_test?.ok) return { label: 'Ready', tone: 'info' };
  return { label: 'Not tested', tone: 'warning' };
}

// ---- Option cards ------------------------------------------------------------------------------------

function OptionCard({ kind, data, selected, onSelect }: { kind: Choice; data: StorageOverview; selected: boolean; onSelect: () => void }) {
  const b = kind === 'DEFAULT' ? undefined : data.backends.find((x) => x.kind === kind);
  const m = META[kind];
  const state = stateOf(b, data.active, kind);
  const inUse = data.active === kind;
  const unavailable = kind === 'LOCAL' && !data.local.available;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group bg-card relative flex flex-col gap-3 rounded-xl border p-4 text-left transition-all hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        selected ? 'border-primary ring-primary/20 ring-2' : 'hover:border-foreground/20',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={cn('flex size-10 items-center justify-center rounded-lg', inUse ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground group-hover:text-foreground')}>
          <m.icon className="size-5" />
        </span>
        <span className={cn('mt-1 flex size-4 items-center justify-center rounded-full border-2', inUse ? 'border-primary' : 'border-muted-foreground/40')} aria-hidden>
          {inUse && <span className="bg-primary size-2 rounded-full" />}
        </span>
      </div>
      <div>
        <p className="font-semibold">{m.label}</p>
        <p className="text-muted-foreground text-xs">{m.blurb}</p>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <StatusBadge status={unavailable ? 'Unavailable' : state.label} tone={unavailable ? 'neutral' : state.tone} />
        {b && b.usage.files > 0 && (
          <span className="text-muted-foreground text-xs">
            {b.usage.files.toLocaleString('en-IN')} files · {formatBytes(b.usage.bytes)}
          </span>
        )}
      </div>
    </button>
  );
}

// ---- Form pieces -------------------------------------------------------------------------------------

function Field({ id, label, hint, optional, locked, children }: { id: string; label: string; hint?: ReactNode; optional?: boolean; locked?: boolean; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex items-center gap-1.5">
        {label}
        {optional && <span className="text-muted-foreground font-normal">(optional)</span>}
        {locked && <Lock className="text-muted-foreground size-3" aria-label="Locked while files are stored here" />}
      </Label>
      {children}
      {hint && <p className="text-muted-foreground text-[11px] leading-relaxed">{hint}</p>}
    </div>
  );
}

function Toggle({ label, description, checked, onChange, disabled }: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />
    </div>
  );
}

function CheckList({ checks }: { checks: StorageCheck[] }) {
  return (
    <ul className="divide-y rounded-lg border text-sm" aria-label="Connection test results">
      {checks.map((c, i) => (
        <li key={`${c.name}-${i}`} className="flex items-start gap-3 px-3 py-2.5">
          {c.ok ? <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" /> : <XCircle className="text-destructive mt-0.5 size-4 shrink-0" />}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{c.name}</p>
            {c.detail && <p className={cn('text-xs break-words', c.ok ? 'text-muted-foreground' : 'text-destructive')}>{c.detail}</p>}
          </div>
          {c.ms !== undefined && <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">{c.ms} ms</span>}
        </li>
      ))}
    </ul>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold">{n}</span>
      <div className="text-muted-foreground min-w-0 pt-0.5 text-sm leading-relaxed [&_b]:text-foreground [&_b]:font-medium">{children}</div>
    </li>
  );
}

function Guide({ kind, bucket, serviceAccount, root }: { kind: StorageKind; bucket: string; serviceAccount: string | null; root: string | null }) {
  const policy = JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: `arn:aws:s3:::${bucket || 'your-bucket'}` },
        { Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'], Resource: `arn:aws:s3:::${bucket || 'your-bucket'}/*` },
      ],
    },
    null,
    2,
  );
  if (kind === 'S3') {
    return (
      <ol className="space-y-3">
        <Step n={1}>Create a <b>private</b> bucket (Block Public Access on) in the region nearest your servers — <b>ap-south-1</b> (Mumbai) for India.</Step>
        <Step n={2}>
          Create an IAM user with only this policy, then create an access key for it.
          <div className="relative mt-2">
            <pre className="bg-muted/60 max-h-48 overflow-auto rounded-md p-3 font-mono text-[11px] leading-snug">{policy}</pre>
            <Button size="icon" variant="ghost" className="absolute top-1 right-1 size-7" aria-label="Copy policy" onClick={() => copy(policy, 'Policy')}><Copy className="size-3.5" /></Button>
          </div>
        </Step>
        <Step n={3}>Enter the bucket, region and access key here, <b>Save</b>, then <b>Test connection</b>.</Step>
        <Step n={4}>For Cloudflare R2, MinIO or other S3-compatible storage, also set the <b>endpoint</b> and usually <b>path-style</b> addressing.</Step>
      </ol>
    );
  }
  if (kind === 'GOOGLE_DRIVE') {
    return (
      <ol className="space-y-3">
        <Step n={1}>In <b>Google Cloud Console</b>, create (or pick) a project and enable the <b>Google Drive API</b>.</Step>
        <Step n={2}>Create a <b>service account</b> → Keys → Add key → <b>JSON</b>. Upload that file here.</Step>
        <Step n={3}>
          In Google Drive, create a <b>Shared Drive</b> and a folder in it, then add {serviceAccount ? <button type="button" className="text-foreground inline-flex items-center gap-1 font-mono text-xs underline decoration-dotted" onClick={() => copy(serviceAccount, 'Email')}>{serviceAccount}<Copy className="size-3" /></button> : 'the service account’s email'} as a <b>Content manager</b>.
        </Step>
        <Step n={4}>Open the folder and copy its ID from the address bar: drive.google.com/drive/folders/<b>&lt;ID&gt;</b> (pasting the whole link works too).</Step>
        <Step n={5}><b>Save</b>, then <b>Test connection</b>.</Step>
        <li className="bg-warning-muted/60 text-warning-foreground dark:text-warning rounded-md p-3 text-xs leading-relaxed">
          Service accounts have no Drive storage of their own, so a folder in someone’s personal <b>My Drive</b> won’t work. Shared Drives need Google Workspace; otherwise use domain-wide delegation and “Act as user”.
        </li>
      </ol>
    );
  }
  return (
    <ol className="space-y-3">
      <Step n={1}>Files are written under <b className="font-mono text-xs break-all">{root ?? 'LOCAL_STORAGE_ROOT'}</b> in the folder you choose, readable only by the server process.</Step>
      <Step n={2}>Use this only with <b>one server</b>, or with a shared volume (NFS/EFS) mounted at the same path on <b>every API and jobs server</b>.</Step>
      <Step n={3}><b>Back the folder up</b> together with the database: the database holds the keys to decrypt the files, and neither is useful without the other.</Step>
    </ol>
  );
}

// ---- Setup panel -------------------------------------------------------------------------------------

function initialConfig(kind: StorageKind, b: StorageBackendRow | undefined, defaults: StorageOverview['server_default']): Record<string, unknown> {
  if (b?.config) return { ...b.config };
  if (kind === 'S3') return { bucket: '', region: defaults.region || 'ap-south-1', endpoint: '', force_path_style: false, prefix: '', sse: '', kms_key_id: '', use_instance_role: false };
  if (kind === 'GOOGLE_DRIVE') return { folder_id: '', impersonate_user: '' };
  return { directory: 'pay2all' };
}

function folderIdFrom(input: string): string {
  const m = /\/folders\/([A-Za-z0-9_-]+)/.exec(input) ?? /[?&]id=([A-Za-z0-9_-]+)/.exec(input);
  return (m?.[1] ?? input).trim();
}

function SetupPanel({ kind, data, onActivate }: { kind: StorageKind; data: StorageOverview; onActivate: () => void }) {
  const qc = useQueryClient();
  const b = data.backends.find((x) => x.kind === kind)!;
  const [config, setConfig] = useState<Record<string, unknown>>(() => initialConfig(kind, b, data.server_default));
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [keyFile, setKeyFile] = useState<{ name: string; json: Record<string, unknown> } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [checks, setChecks] = useState<StorageCheck[] | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const locked = b.usage.files > 0 ? LOCKED[kind] : [];
  const set = (k: string, v: unknown) => setConfig((c) => ({ ...c, [k]: v }));
  const str = (k: string) => (config[k] === undefined || config[k] === null ? '' : String(config[k]));
  const unavailable = kind === 'LOCAL' && !data.local.available;
  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(initialConfig(kind, b, data.server_default)) || Object.values(secret).some(Boolean) || keyFile !== null, [config, secret, keyFile, kind, b, data.server_default]);
  const secretComplete = kind === 'S3' ? Boolean(secret.access_key_id?.trim() && secret.secret_access_key?.trim()) : kind === 'GOOGLE_DRIVE' ? keyFile !== null : false;
  const secretPartial = kind === 'S3' && Boolean(secret.access_key_id?.trim() || secret.secret_access_key?.trim()) && !secretComplete;

  async function save() {
    setBusy('save');
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = { config, reason: reason.trim() };
      if (secretComplete) body.secret = kind === 'GOOGLE_DRIVE' ? keyFile!.json : { access_key_id: secret.access_key_id!.trim(), secret_access_key: secret.secret_access_key!.trim() };
      const next = await api.put<StorageOverview>(`/v1/storage/backends/${kind}`, body);
      qc.setQueryData(KEY, next);
      setReason('');
      toast.success(b.configured ? 'Settings saved' : `${META[kind].label} saved — now test the connection`);
    } catch (e) {
      if (e instanceof ApiError && e.details?.length) setFieldErrors(Object.fromEntries(e.details.map((d) => [d.path.replace(/^(config|secret)\./, ''), d.message])));
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setChecks(null);
    try {
      const r = await api.post<{ ok: boolean; checks: StorageCheck[] }>(`/v1/storage/backends/${kind}/test`, {});
      setChecks(r.checks);
      if (r.ok) toast.success('Connection works');
      else toast.error('Connection test failed');
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    try {
      const next = await api.post<StorageOverview>(`/v1/storage/backends/${kind}/remove`, { reason: reason.trim() });
      qc.setQueryData(KEY, next);
      setReason('');
      toast.success(`${META[kind].label} settings removed`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function onKeyFile(file: File | undefined) {
    if (!file) return;
    try {
      const json = JSON.parse(await file.text()) as Record<string, unknown>;
      if (json.type !== 'service_account' || typeof json.client_email !== 'string') throw new Error('not a key');
      setKeyFile({ name: file.name, json });
    } catch {
      toast.error('That is not a Google service account key file (JSON with "type": "service_account")');
    }
  }

  const err = (k: string) => fieldErrors[k] && <p className="text-destructive text-[11px]">{fieldErrors[k]}</p>;
  const lastChecks = checks ?? (b.last_test && b.last_test.ok === false && b.last_test.error ? [{ name: 'Last test', ok: false, detail: b.last_test.error }] : null);
  const M = META[kind];

  return (
    <Card className="gap-0 overflow-hidden pt-0 shadow-none">
      <CardHeader className="bg-muted/30 border-b pt-5 [.border-b]:pb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="bg-background flex size-10 items-center justify-center rounded-lg border"><M.icon className="size-5" /></span>
            <div>
              <CardTitle className="text-base">{M.label}</CardTitle>
              <CardDescription>
                {b.is_active ? 'New files are stored here.' : b.configured ? 'Set up, not in use.' : 'Not set up yet.'}
                {b.last_test && <> Last tested {formatRelative(b.last_test.at)}{b.last_test.ok ? ' — passed' : ' — failed'}.</>}
              </CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {b.configured && (
              <Button variant="outline" size="sm" disabled={busy !== null || dirty} onClick={() => void test()} title={dirty ? 'Save your changes first' : undefined}>
                {busy === 'test' ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection
              </Button>
            )}
            {b.configured && !b.is_active && (
              <Button size="sm" disabled={busy !== null || dirty} onClick={onActivate}>
                <ShieldCheck /> Use for new files
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 pt-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          {unavailable ? (
            <div className="rounded-lg border border-dashed p-4 text-sm">
              <p className="font-medium">Not available on this server</p>
              <p className="text-muted-foreground mt-1">Set <span className="font-mono text-xs">LOCAL_STORAGE_ROOT</span> to an absolute directory in the server’s environment and restart it to enable local disk storage.</p>
            </div>
          ) : (
            <>
              {locked.length > 0 && (
                <p className="bg-muted/60 text-muted-foreground flex items-start gap-2 rounded-md p-3 text-xs">
                  <Lock className="mt-0.5 size-3.5 shrink-0" />
                  {b.usage.files.toLocaleString('en-IN')} files are stored here, so the location fields are locked. To move to a new location, set it up as a different storage type.
                </p>
              )}

              {kind === 'S3' && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="s3-bucket" label="Bucket" locked={locked.includes('bucket')}>
                    <Input id="s3-bucket" value={str('bucket')} disabled={locked.includes('bucket')} onChange={(e) => set('bucket', e.target.value.trim())} placeholder="pay2all-files-prod" autoComplete="off" />
                    {err('bucket')}
                  </Field>
                  <Field id="s3-region" label="Region" locked={locked.includes('region')}>
                    <Input id="s3-region" value={str('region')} disabled={locked.includes('region')} onChange={(e) => set('region', e.target.value.trim())} placeholder="ap-south-1" autoComplete="off" />
                    {err('region')}
                  </Field>
                  <Field id="s3-prefix" label="Folder in bucket" optional locked={locked.includes('prefix')} hint="e.g. pay2all/ — keeps Pay2All files apart if the bucket is shared.">
                    <Input id="s3-prefix" value={str('prefix')} disabled={locked.includes('prefix')} onChange={(e) => set('prefix', e.target.value.trim())} placeholder="pay2all/" autoComplete="off" />
                    {err('prefix')}
                  </Field>
                  <Field id="s3-endpoint" label="Endpoint" optional locked={locked.includes('endpoint')} hint="Leave empty for Amazon S3.">
                    <Input id="s3-endpoint" value={str('endpoint')} disabled={locked.includes('endpoint')} onChange={(e) => set('endpoint', e.target.value.trim())} placeholder="https://<account>.r2.cloudflarestorage.com" autoComplete="off" />
                    {err('endpoint')}
                  </Field>
                  <Field id="s3-sse" label="Server-side encryption" hint="On top of Pay2All’s own encryption.">
                    <Select value={str('sse') || 'none'} onValueChange={(v) => set('sse', v === 'none' ? '' : v)}>
                      <SelectTrigger id="s3-sse" aria-label="Server-side encryption"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Bucket default</SelectItem>
                        <SelectItem value="AES256">S3-managed keys (SSE-S3)</SelectItem>
                        <SelectItem value="aws:kms">AWS KMS (SSE-KMS)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  {str('sse') === 'aws:kms' ? (
                    <Field id="s3-kms" label="KMS key ID or ARN" optional>
                      <Input id="s3-kms" value={str('kms_key_id')} onChange={(e) => set('kms_key_id', e.target.value.trim())} placeholder="arn:aws:kms:ap-south-1:…:key/…" autoComplete="off" />
                    </Field>
                  ) : <div className="hidden sm:block" />}
                  <div className="space-y-2 sm:col-span-2">
                    <Toggle label="Path-style addressing" description="Needed by MinIO, SeaweedFS and some S3-compatible services." checked={config.force_path_style === true} onChange={(v) => set('force_path_style', v)} disabled={locked.includes('force_path_style')} />
                    <Toggle label="Use the server’s IAM role" description="On AWS (EC2, ECS, EKS): no stored keys needed." checked={config.use_instance_role === true} onChange={(v) => set('use_instance_role', v)} />
                  </div>
                </div>
              )}

              {kind === 'GOOGLE_DRIVE' && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="gd-folder" label="Folder ID" locked={locked.includes('folder_id')} hint="Paste the folder’s link or its ID.">
                    <Input id="gd-folder" value={str('folder_id')} disabled={locked.includes('folder_id')} onChange={(e) => set('folder_id', folderIdFrom(e.target.value))} placeholder="1AbC…" autoComplete="off" className="font-mono text-xs" />
                    {err('folder_id')}
                  </Field>
                  <Field id="gd-sub" label="Act as user" optional hint="Workspace domain-wide delegation only.">
                    <Input id="gd-sub" type="email" value={str('impersonate_user')} onChange={(e) => set('impersonate_user', e.target.value.trim())} placeholder="files@yourcompany.com" autoComplete="off" />
                    {err('impersonate_user')}
                  </Field>
                </div>
              )}

              {kind === 'LOCAL' && (
                <Field id="lc-dir" label="Folder" locked={locked.includes('directory')} hint={<>Files go to <span className="font-mono break-all">{data.local.root}/{str('directory') || '…'}</span></>}>
                  <Input id="lc-dir" value={str('directory')} disabled={locked.includes('directory')} onChange={(e) => set('directory', e.target.value.trim())} placeholder="pay2all" autoComplete="off" className="font-mono text-sm" />
                  {err('directory')}
                </Field>
              )}

              {kind !== 'LOCAL' && !(kind === 'S3' && config.use_instance_role === true) && (
                <div className="space-y-3 rounded-lg border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm font-medium"><FileKey2 className="size-4" /> Credentials</p>
                    {b.has_secret ? (
                      <span className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px]">
                        {Object.entries(b.secret_fingerprints).map(([k, v]) => <span key={k}>{k}: {v}</span>)}
                      </span>
                    ) : <StatusBadge status="Not added" tone="warning" />}
                  </div>
                  <p className="text-muted-foreground text-xs">Encrypted when saved and never shown again. {b.has_secret ? 'Leave empty to keep the stored ones.' : ''}</p>
                  {kind === 'S3' ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input aria-label="Access key ID" placeholder="Access key ID" autoComplete="off" value={secret.access_key_id ?? ''} onChange={(e) => setSecret((s) => ({ ...s, access_key_id: e.target.value }))} />
                      <Input aria-label="Secret access key" type="password" placeholder="Secret access key" autoComplete="new-password" value={secret.secret_access_key ?? ''} onChange={(e) => setSecret((s) => ({ ...s, secret_access_key: e.target.value }))} />
                      {secretPartial && <p className="text-destructive text-[11px] sm:col-span-2">Enter both the access key ID and the secret.</p>}
                    </div>
                  ) : (
                    <label className={cn('hover:bg-muted/40 flex cursor-pointer items-center gap-3 rounded-md border border-dashed p-3 transition-colors', keyFile && 'border-success/50 bg-success-muted/30')}>
                      <Upload className="text-muted-foreground size-4 shrink-0" />
                      <span className="min-w-0 text-sm">
                        {keyFile ? (
                          <><span className="font-medium">{keyFile.name}</span><span className="text-muted-foreground block truncate font-mono text-[11px]">{String(keyFile.json.client_email)}</span></>
                        ) : (
                          <><span className="font-medium">Upload service account key</span><span className="text-muted-foreground block text-xs">The .json file from Google Cloud</span></>
                        )}
                      </span>
                      <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { void onKeyFile(e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor={`reason-${kind}`}>Reason for change <span className="text-muted-foreground font-normal">(audited)</span></Label>
                <Textarea id={`reason-${kind}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Moving KYC documents to our own AWS account" />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {b.configured && !b.is_active && b.usage.files === 0 ? (
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={busy !== null || reason.trim().length < 5} onClick={() => void remove()}>
                    {busy === 'remove' ? <Loader2 className="animate-spin" /> : <Trash2 />} Remove settings
                  </Button>
                ) : <span />}
                <Button disabled={busy !== null || !dirty || reason.trim().length < 5 || secretPartial} onClick={() => void save()}>
                  {busy === 'save' && <Loader2 className="animate-spin" />} {b.configured ? 'Save changes' : 'Save'}
                </Button>
              </div>
              {b.is_active && dirty && <p className="text-muted-foreground text-xs">This storage is in use: new settings are tested before they’re saved, and nothing changes if the test fails.</p>}
            </>
          )}

          {lastChecks && <CheckList checks={lastChecks} />}
        </div>

        <aside className="bg-muted/30 h-fit rounded-xl border p-5">
          <p className="mb-4 text-sm font-semibold">How to set up</p>
          <Guide kind={kind} bucket={str('bucket')} serviceAccount={keyFile ? String(keyFile.json.client_email) : (b.secret_fingerprints.client_email ?? null)} root={data.local.root} />
        </aside>
      </CardContent>
    </Card>
  );
}

function DefaultPanel({ data, onActivate }: { data: StorageOverview; onActivate: () => void }) {
  const d = data.server_default;
  const rows: [string, ReactNode][] = [
    ['Bucket', <span key="b" className="font-mono text-xs">{d.bucket}</span>],
    ['Region', d.region],
    ['Endpoint', d.endpoint ? <span key="e" className="font-mono text-xs">{d.endpoint}</span> : 'Amazon S3'],
    ['Server-side encryption', d.server_side_encryption ?? 'Bucket default'],
  ];
  return (
    <Card className="gap-0 overflow-hidden pt-0 shadow-none">
      <CardHeader className="bg-muted/30 border-b pt-5 [.border-b]:pb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="bg-background flex size-10 items-center justify-center rounded-lg border"><Server className="size-5" /></span>
            <div>
              <CardTitle className="text-base">Server default</CardTitle>
              <CardDescription>Set through the server’s environment (S3_*). Read-only here. Files written before any storage was chosen live here.</CardDescription>
            </div>
          </div>
          {data.active !== 'DEFAULT' && <Button size="sm" variant="outline" onClick={onActivate}>Use server default</Button>}
        </div>
      </CardHeader>
      <CardContent className="pt-6">
        <dl className="divide-y rounded-lg border text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 px-3 py-2"><dt className="text-muted-foreground">{k}</dt><dd className="text-right">{v}</dd></div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function ActivateDialog({ target, data, onClose }: { target: Choice | null; data: StorageOverview; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ message: string; details: { path: string; message: string }[] } | null>(null);
  if (!target) return null;
  async function submit() {
    setBusy(true);
    setFailed(null);
    try {
      const next = await api.post<StorageOverview>('/v1/storage/active', { kind: target, reason: reason.trim() });
      qc.setQueryData(KEY, next);
      toast.success(`New files now go to ${META[target!].label}`);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.details?.length) setFailed({ message: e.message, details: e.details });
      else toast.error(errorMessage(e));
      await qc.invalidateQueries({ queryKey: KEY });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Store new files in {META[target].label}?</DialogTitle>
          <DialogDescription>
            From {META[data.active].label} to {META[target].label}. Existing files stay where they are and remain readable.{target !== 'DEFAULT' && ' A connection test runs first; nothing changes if it fails.'}
          </DialogDescription>
        </DialogHeader>
        {failed && (
          <div className="space-y-2">
            <p className="text-destructive text-sm font-medium">{failed.message}</p>
            <CheckList checks={failed.details.map((d) => ({ name: d.path, ok: false, detail: d.message }))} />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="activate-reason">Reason (audited)</Label>
          <Textarea id="activate-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Production go-live on our AWS account" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || reason.trim().length < 5} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} {busy && target !== 'DEFAULT' ? 'Testing…' : 'Switch'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StorageSettings() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<StorageOverview>('/v1/storage/backends') });
  const [selected, setSelected] = useState<Choice | null>(null);
  const [activating, setActivating] = useState<Choice | null>(null);
  const data = q.data;
  const view: Choice = selected ?? data?.active ?? 'DEFAULT';

  if (q.error) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (!data) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36 rounded-xl" />)}</div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          New files go to <span className="font-semibold">{META[data.active].label}</span>
        </p>
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs"><ShieldCheck className="text-success size-3.5" /> AES-256-GCM per file · keys stay in Pay2All’s database</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" role="group" aria-label="Storage options">
        {(['DEFAULT', 'S3', 'GOOGLE_DRIVE', 'LOCAL'] as const).map((k) => <OptionCard key={k} kind={k} data={data} selected={view === k} onSelect={() => setSelected(k)} />)}
      </div>
      {view === 'DEFAULT' ? <DefaultPanel data={data} onActivate={() => setActivating('DEFAULT')} /> : <SetupPanel key={`${view}:${data.backends.find((x) => x.kind === view)?.version ?? 0}`} kind={view} data={data} onActivate={() => setActivating(view)} />}
      <ActivateDialog key={activating ?? 'none'} target={activating} data={data} onClose={() => setActivating(null)} />
    </div>
  );
}
