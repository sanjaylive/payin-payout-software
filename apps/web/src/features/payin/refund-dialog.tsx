'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Textarea } from '@pay2all/ui/components/ui/textarea';
import { formatMinor } from '@pay2all/ui/lib/money';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { majorToMinor } from '@/features/ledger/format';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Payment, Refund } from '@/lib/api/types';
import { keyAfterError, newIdempotencyKey } from './labels';

const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;
const toMajor = (minor: bigint) => `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;

function RefundForm({ payment, onDone, refundableMinor }: { payment: Payment; onDone: () => void; refundableMinor: bigint }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState(() => toMajor(refundableMinor));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // One key per dialog session: a network retry of the same submission can't refund twice.
  const [key, setKey] = useState(newIdempotencyKey);

  const valid = AMOUNT.test(amount) && majorToMinor(amount) > 0n && majorToMinor(amount) <= refundableMinor;

  async function submit() {
    setBusy(true);
    try {
      const body = { amount: toMajor(majorToMinor(amount)), ...(reason.trim() ? { reason: reason.trim() } : {}) };
      const r = await api.post<Refund>(`/v1/payments/${payment.payment_id}/refunds`, body, { headers: { 'Idempotency-Key': key } });
      toast.success(`Refund of ${formatMinor(majorToMinor(r.amount))} initiated`);
      onDone();
      await qc.invalidateQueries({ queryKey: ['payment', payment.payment_id] });
      await qc.invalidateQueries({ queryKey: ['payments'] });
      await qc.invalidateQueries({ queryKey: ['refunds'] });
    } catch (e) {
      setKey((k) => keyAfterError(e, k));
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Refund payment</DialogTitle>
        <DialogDescription>
          Up to {formatMinor(refundableMinor)} can be refunded. The amount is deducted from your balance now and returned if the bank rejects the refund. Fees are not reversed.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="refund-amount">Amount (₹)</Label>
          <Input id="refund-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={amount !== '' && !valid} />
          {amount !== '' && !valid && <p className="text-destructive text-xs">Enter an amount between ₹0.01 and {formatMinor(refundableMinor)}.</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="refund-reason">Reason (optional)</Label>
          <Textarea id="refund-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Order cancelled by customer" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button disabled={!valid || busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Refund {valid ? formatMinor(majorToMinor(amount)) : ''}</Button>
      </DialogFooter>
    </>
  );
}

export function RefundDialog({ payment, open, onOpenChange, refundableMinor }: { payment: Payment; open: boolean; onOpenChange: (o: boolean) => void; refundableMinor: bigint }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, so each opening starts fresh (amount, reason, idempotency key). */}
      <DialogContent>{open && <RefundForm payment={payment} refundableMinor={refundableMinor} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}
