'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { QrCode } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PaymentQr } from '@/features/payin/payment-qr';
import { inr, upiPayload } from './api';
import { useAgentProfile } from './hooks';

/** "Collect via UPI": the shop's own UPI QR with the amount filled in. Money goes straight to the shop's bank. */
export function UpiCollectButton({ amount, note, className }: { amount: string; note?: string; className?: string }) {
  const profile = useAgentProfile();
  const [open, setOpen] = useState(false);
  const p = profile.data;
  if (!p) return null;
  if (!p.upi_vpa) {
    return (
      <p className="text-muted-foreground text-xs">
        Add your UPI id in{' '}
        <Link href="/agent/settings" className="text-primary underline-offset-2 hover:underline">
          Shop settings
        </Link>{' '}
        to show a payment QR here.
      </p>
    );
  }
  const valid = Number(amount) >= 1;
  const payee = p.upi_payee_name || p.shop_name;
  return (
    <>
      <Button type="button" variant="outline" className={className} disabled={!valid} onClick={() => setOpen(true)}>
        <QrCode /> Collect {valid ? inr(amount) : ''} via UPI
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Scan to pay {inr(amount)}</DialogTitle>
            <DialogDescription>
              Paying {payee} · {p.upi_vpa}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            <PaymentQr payload={upiPayload(p.upi_vpa, payee, amount, note)} size={240} alt={`UPI QR to pay ${inr(amount)} to ${payee}`} />
            <p className="text-muted-foreground text-center text-xs">Ask the customer to scan with any UPI app. Check the money has reached your account, then save the entry with the UPI reference.</p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
