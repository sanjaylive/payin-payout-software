'use client';

import { Button } from '@pay2all/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@pay2all/ui/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@pay2all/ui/components/ui/tooltip';
import { cn } from '@pay2all/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2, MessageCircle, MessageSquareText, Printer, Send } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormError } from '@/components/auth/form-error';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api/client';
import { useCan } from '@/lib/auth/use-me';
import { type AgentReceipt, inr, whatsappUrl } from './api';
import { AGENT_KEY, useAgentProfile } from './hooks';

/** Print, copy link, free WhatsApp share, and SMS/WhatsApp sending on plans with messaging. */
export function ReceiptActions({ receipt, onPrint, className }: { receipt: AgentReceipt; onPrint?: () => void; className?: string }) {
  const can = useCan();
  const profile = useAgentProfile();
  const [channel, setChannel] = useState<'SMS' | 'WHATSAPP' | null>(null);
  const t = receipt.transaction;
  const messaging = profile.data?.plan.messaging ?? false;
  const shareText = `${receipt.shop.name}: ${receipt.type_label} of ${inr(t.amount)} — receipt ${t.receipt_no}. View: ${receipt.public_url}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(receipt.public_url);
      toast.success('Receipt link copied');
    } catch {
      toast.error('Could not copy. Long-press the link to copy it.');
    }
  }

  const big = 'h-11 justify-start sm:justify-center';
  return (
    <div className={cn('grid grid-cols-2 gap-2 sm:flex sm:flex-wrap', className)}>
      <Button variant="outline" className={big} onClick={onPrint ?? (() => window.print())}>
        <Printer /> Print / Save PDF
      </Button>
      <Button variant="outline" className={big} onClick={() => void copy()}>
        <Copy /> Copy link
      </Button>
      <Button variant="outline" className={cn(big, 'col-span-2 sm:col-span-1')} asChild>
        <a href={whatsappUrl(shareText, t.customer?.mobile)} target="_blank" rel="noopener noreferrer">
          <MessageCircle /> Share on WhatsApp
        </a>
      </Button>
      {can('agent.desk.write') &&
        (['SMS', 'WHATSAPP'] as const).map((c) =>
          messaging ? (
            <Button key={c} variant="secondary" className={big} onClick={() => setChannel(c)}>
              {c === 'SMS' ? <MessageSquareText /> : <Send />} {c === 'SMS' ? 'Send SMS' : 'Send WhatsApp'}
            </Button>
          ) : (
            <Tooltip key={c}>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex">
                  <Button variant="secondary" className={cn(big, 'w-full')} disabled>
                    {c === 'SMS' ? <MessageSquareText /> : <Send />} {c === 'SMS' ? 'Send SMS' : 'Send WhatsApp'}
                    <span className="bg-primary/10 text-primary rounded px-1.5 text-[10px] font-semibold">Business</span>
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Automatic SMS and WhatsApp receipts come with the Business plan.{' '}
                <Link href="/agent/plan" className="underline">
                  See plans
                </Link>
              </TooltipContent>
            </Tooltip>
          ),
        )}
      <SendDialog receipt={receipt} channel={channel} onClose={() => setChannel(null)} />
    </div>
  );
}

function SendDialog({ receipt, channel, onClose }: { receipt: AgentReceipt; channel: 'SMS' | 'WHATSAPP' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const t = receipt.transaction;
  const [mobile, setMobile] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function send() {
    if (!channel) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/agent/transactions/${t.id}/send-receipt`, { channel, ...(mobile.trim() ? { mobile: mobile.trim() } : {}) });
      toast.success(channel === 'SMS' ? 'SMS queued' : 'WhatsApp message queued');
      await qc.invalidateQueries({ queryKey: AGENT_KEY });
      setMobile('');
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={Boolean(channel)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{channel === 'SMS' ? 'Send receipt by SMS' : 'Send receipt on WhatsApp'}</DialogTitle>
          <DialogDescription>The customer gets a short message with the receipt link.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <FormError error={error} />
          <FormField
            label="Mobile number"
            type="tel"
            inputMode="tel"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            placeholder={t.customer?.mobile ? t.customer.mobile.replace(/^\+91/, '') : '98765 43210'}
            hint={t.customer?.mobile ? 'Leave blank to use the customer’s number' : 'Required: no mobile number on this entry'}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (!t.customer?.mobile && !mobile.trim())}>
              {busy ? <Loader2 className="animate-spin" /> : <Send />} Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
