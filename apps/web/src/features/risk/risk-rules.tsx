'use client';

import { DataTable } from '@pay2all/ui/components/data-table';
import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { Alert, AlertDescription } from '@pay2all/ui/components/ui/alert';
import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pay2all/ui/components/ui/select';
import { Switch } from '@pay2all/ui/components/ui/switch';
import { allowedRiskActions, allowedRiskServices } from '@pay2all/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage, toTableError } from '@/lib/api/errors';
import type { RiskAction, RiskRule, RiskRuleType } from '@/lib/api/types';
import { useCan } from '@/lib/auth/use-me';
import { ACTION_HELP, ACTION_LABELS, INLINE_TYPES, PARAM_FIELDS, paramsSummary, RULE_TYPE_LABELS } from './risk-labels';

type Editing = { mode: 'create' } | { mode: 'edit'; rule: RiskRule };

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

function RuleDialog({ editing, onClose }: { editing: Editing | null; onClose: () => void }) {
  const qc = useQueryClient();
  const rule = editing?.mode === 'edit' ? editing.rule : null;
  const [code, setCode] = useState('');
  const [type, setType] = useState<RiskRuleType>(rule?.type ?? 'VELOCITY');
  const [service, setService] = useState<'PAYIN' | 'PAYOUT'>(rule?.service ?? 'PAYIN');
  const [name, setName] = useState(rule?.name ?? '');
  const [action, setAction] = useState<RiskAction>(rule?.action ?? 'MANUAL_REVIEW');
  const [mode, setMode] = useState<'ENFORCE' | 'MONITOR'>(rule?.mode ?? 'MONITOR');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(rule?.params ?? {}).map(([k, v]) => [k, String(v)])));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const services = allowedRiskServices(type);
  const effectiveService = services.includes(service) ? service : services[0]!;
  const actions = allowedRiskActions(type, effectiveService) as RiskAction[];
  const effectiveAction = actions.includes(action) ? action : actions[0]!;
  const fields = PARAM_FIELDS[type];
  const paramsValid = fields.every((f) => (f.kind === 'money' ? MONEY.test(params[f.key] ?? '') : /^\d{1,9}$/.test(params[f.key] ?? '')));
  const valid = paramsValid && name.trim().length >= 3 && (rule ? reason.trim().length >= 5 : /^[A-Z][A-Z0-9_]{2,59}$/.test(code));

  async function submit() {
    const body = {
      name: name.trim(),
      action: effectiveAction,
      mode,
      enabled,
      params: Object.fromEntries(fields.map((f) => [f.key, f.kind === 'money' ? (params[f.key]!.includes('.') ? params[f.key]! : `${params[f.key]}.00`) : Number(params[f.key])])),
    };
    setBusy(true);
    try {
      if (rule) await api.patch(`/v1/risk/rules/${rule.rule_id}`, { ...body, reason: reason.trim() });
      else await api.post('/v1/risk/rules', { ...body, code, type, service: effectiveService });
      toast.success(rule ? 'Rule updated' : 'Rule created');
      await qc.invalidateQueries({ queryKey: ['risk-rules'] });
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule ? `Edit ${rule.code}` : 'New risk rule'}</DialogTitle>
          <DialogDescription>{rule ? `Version ${rule.version} → ${rule.version + 1}. Past events keep the parameters they fired with.` : 'Start in Monitor mode to see how often it would fire before enforcing it.'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!rule && (
            <>
              <div className="space-y-1.5"><Label htmlFor="rr-code">Code</Label><Input id="rr-code" className="font-mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="PAYOUT_VELOCITY_5M" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select value={type} onValueChange={(v) => { setType(v as RiskRuleType); setParams({}); }}>
                    <SelectTrigger aria-label="Rule type"><SelectValue /></SelectTrigger>
                    <SelectContent>{(Object.keys(RULE_TYPE_LABELS) as RiskRuleType[]).map((t) => <SelectItem key={t} value={t}>{RULE_TYPE_LABELS[t]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Watches</Label>
                  <Select value={effectiveService} onValueChange={(v) => setService(v as 'PAYIN' | 'PAYOUT')}>
                    <SelectTrigger aria-label="Service"><SelectValue /></SelectTrigger>
                    <SelectContent>{services.map((s) => <SelectItem key={s} value={s}>{s === 'PAYIN' ? 'Payins' : 'Payouts'}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-muted-foreground text-xs">{INLINE_TYPES.includes(type) ? 'Checked inline while each transaction is created.' : 'Checked by the background sweep every 5 minutes.'}</p>
            </>
          )}
          <div className="space-y-1.5"><Label htmlFor="rr-name">Name</Label><Input id="rr-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            {fields.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`rr-${f.key}`}>{f.label}</Label>
                <Input id={`rr-${f.key}`} inputMode={f.kind === 'money' ? 'decimal' : 'numeric'} className="tabular" value={params[f.key] ?? ''} onChange={(e) => setParams((p) => ({ ...p, [f.key]: e.target.value.trim() }))} />
                {f.hint && <p className="text-muted-foreground text-[11px]">{f.hint}</p>}
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label>Action</Label>
            <Select value={effectiveAction} onValueChange={(v) => setAction(v as RiskAction)}>
              <SelectTrigger aria-label="Action"><SelectValue /></SelectTrigger>
              <SelectContent>{actions.map((a) => <SelectItem key={a} value={a}>{ACTION_LABELS[a]}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{ACTION_HELP[effectiveAction]}</p>
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div><p className="text-sm font-medium">Enforce</p><p className="text-muted-foreground text-xs">Off = monitor only: events are recorded, nothing is blocked or held.</p></div>
            <Switch checked={mode === 'ENFORCE'} onCheckedChange={(c) => setMode(c ? 'ENFORCE' : 'MONITOR')} aria-label="Enforce" />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <p className="text-sm font-medium">Enabled</p>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
          </div>
          {rule && <div className="space-y-1.5"><Label htmlFor="rr-reason">Reason for change (audited)</Label><Input id="rr-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
          {mode === 'ENFORCE' && effectiveAction !== 'ALLOW' && (
            <Alert><AlertDescription>Enforcing applies to every merchant immediately (within 15 seconds on each API node).</AlertDescription></Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} {rule ? 'Save changes' : 'Create rule'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RiskRules() {
  const can = useCan();
  const rules = useQuery({ queryKey: ['risk-rules'], queryFn: () => api.get<RiskRule[]>('/v1/risk/rules') });
  const [editing, setEditing] = useState<Editing | null>(null);
  const manage = can('risk.manage');
  return (
    <>
      <DataTable
        rows={rules.data}
        loading={rules.isFetching}
        error={toTableError(rules.error)}
        rowKey={(r) => r.rule_id}
        empty={{ title: 'No risk rules', description: 'Create a rule to start recording risk events.' }}
        toolbar={manage ? <Button size="sm" onClick={() => setEditing({ mode: 'create' })}><Plus /> New rule</Button> : undefined}
        columns={[
          {
            id: 'rule',
            header: 'Rule',
            cell: (r) => (
              <div className="min-w-56 space-y-0.5">
                <p className="font-medium">{r.name}</p>
                <p className="text-muted-foreground font-mono text-[11px]">{r.code} · v{r.version}</p>
              </div>
            ),
          },
          { id: 'watch', header: 'Watches', cell: (r) => <div className="text-sm"><p>{RULE_TYPE_LABELS[r.type]}</p><p className="text-muted-foreground text-xs">{r.service === 'PAYIN' ? 'Payins' : 'Payouts'} · {INLINE_TYPES.includes(r.type) ? 'inline' : 'sweep'}</p></div> },
          { id: 'params', header: 'Thresholds', className: 'min-w-56 whitespace-normal', cell: (r) => <span className="text-muted-foreground text-xs">{paramsSummary(r.type, r.params)}</span> },
          { id: 'action', header: 'Action', cell: (r) => <span className="text-sm">{ACTION_LABELS[r.action]}</span> },
          {
            id: 'mode',
            header: 'Mode',
            cell: (r) => (!r.enabled ? <StatusBadge status="DISABLED" tone="neutral" /> : <StatusBadge status={r.mode === 'ENFORCE' ? 'ENFORCING' : 'MONITOR'} tone={r.mode === 'ENFORCE' ? 'primary' : 'info'} />),
          },
          { id: 'hits', header: 'Hits (24h)', align: 'right', cell: (r) => <span className="tabular text-sm">{r.hits_24h.toLocaleString('en-IN')}</span> },
          { id: 'edit', header: '', align: 'right', cell: (r) => (manage ? <Button size="sm" variant="ghost" aria-label={`Edit ${r.code}`} onClick={() => setEditing({ mode: 'edit', rule: r })}><Pencil /></Button> : null) },
        ]}
      />
      <RuleDialog key={editing ? (editing.mode === 'edit' ? editing.rule.rule_id : 'new') : 'none'} editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}
