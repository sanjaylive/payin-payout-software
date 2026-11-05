'use client';

import { ErrorState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Download, Printer, QrCode, Settings } from 'lucide-react';
import Link from 'next/link';
import { toDataURL } from 'qrcode';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { PaymentQr } from '@/features/payin/payment-qr';
import { apiBlob } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCan } from '@/lib/auth/use-me';
import { AMOUNT_RE, inr, upiPayload } from './api';
import { AGENT_KEY, useAgentProfile } from './hooks';

/** Blob → data URL, so the image needs no object-URL cleanup. */
function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the image'));
    r.readAsDataURL(blob);
  });
}

/** An uploaded image fetched with the session (the API needs the bearer token). */
export function useAuthImage(path: string, enabled: boolean, version = '') {
  const q = useQuery({ queryKey: [...AGENT_KEY, 'image', path, version], queryFn: async () => toDataUrl(await apiBlob(path)), enabled, staleTime: 300_000 });
  return enabled ? (q.data ?? null) : null;
}

/** Print-ready A6 standee: shop name, QR, UPI id, amount if fixed. */
async function standeePng(payload: string, shop: string, vpa: string, amount: string | null): Promise<string> {
  const W = 1240;
  const H = 1748;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#1d4ed8';
  g.fillRect(0, 0, W, 300);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.font = '600 46px system-ui, sans-serif';
  g.fillText(amount ? `Scan to pay ${inr(amount)}` : 'Scan & pay with any UPI app', W / 2, 130);
  g.font = '400 34px system-ui, sans-serif';
  g.fillText('Google Pay · PhonePe · Paytm · BHIM · bank apps', W / 2, 200);
  const qr = new Image();
  qr.src = await toDataURL(payload, { width: 900, margin: 2, errorCorrectionLevel: 'H' });
  await new Promise((r) => (qr.onload = r));
  g.drawImage(qr, (W - 900) / 2, 380, 900, 900);
  g.fillStyle = '#0f172a';
  g.font = '700 64px system-ui, sans-serif';
  g.fillText(shop.slice(0, 32), W / 2, 1400);
  g.fillStyle = '#475569';
  g.font = '400 38px system-ui, sans-serif';
  g.fillText(vpa.slice(0, 48), W / 2, 1470);
  g.font = '400 30px system-ui, sans-serif';
  g.fillText(amount ? 'Check the amount and confirm with your UPI PIN.' : 'Enter the amount in your app and confirm with your UPI PIN.', W / 2, 1560);
  return c.toDataURL('image/png');
}

/** /agent/qr: the shop's UPI QR for customers (optionally with an amount), and the bank's own QR image. */
export function MyQr() {
  const can = useCan();
  const profile = useAgentProfile();
  const [amount, setAmount] = useState('');
  const p = profile.data;
  const bankQr = useAuthImage('/v1/agent/profile/qr', Boolean(p?.has_qr_image));
  if (profile.isError) return <ErrorState message={errorMessage(profile.error)} onRetry={() => void profile.refetch()} />;

  const fixed = AMOUNT_RE.test(amount.trim()) && Number(amount) >= 1 ? Number(amount).toFixed(2) : null;
  const payee = p ? p.upi_payee_name || p.shop_name : '';
  const payload = p?.upi_vpa ? upiPayload(p.upi_vpa, payee, fixed ?? undefined) : null;

  async function makePng() {
    return standeePng(payload!, payee, p!.upi_vpa!, fixed);
  }
  async function download() {
    const url = await makePng();
    Object.assign(document.createElement('a'), { href: url, download: `upi-qr${fixed ? `-${fixed}` : ''}.png` }).click();
  }
  async function print() {
    const url = await makePng();
    const w = window.open('', '_blank', 'noopener=no');
    if (!w) return toast.error('Allow pop-ups to print');
    w.document.title = 'UPI QR';
    const img = w.document.createElement('img');
    img.src = url;
    img.style.cssText = 'width:100%;max-width:105mm;display:block;margin:auto';
    w.document.body.appendChild(img);
    img.onload = () => w.print();
  }

  return (
    <>
      <PageHeader title="My QR" description="Customers scan this to pay you by UPI. The money goes straight to your bank account." />
      {!p ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="bg-card flex flex-col items-center gap-4 rounded-xl border p-5 text-center">
            {payload ? (
              <>
                <div>
                  <p className="text-lg font-semibold">{payee}</p>
                  <p className="text-muted-foreground text-sm">{p.upi_vpa}</p>
                </div>
                <PaymentQr payload={payload} size={240} alt={`UPI QR for ${payee}${fixed ? `, ${inr(fixed)}` : ''}`} />
                {fixed && <p className="text-2xl font-semibold tabular-nums">{inr(fixed)}</p>}
                <div className="w-full max-w-xs space-y-1.5 text-left">
                  <Label htmlFor="qr-amount">Amount for one payment (optional)</Label>
                  <Input id="qr-amount" inputMode="decimal" className="h-11 text-lg" placeholder="Any amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" className="h-11" onClick={() => void download()}>
                    <Download /> Download standee
                  </Button>
                  <Button variant="outline" className="h-11" onClick={() => void print()}>
                    <Printer /> Print
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-3 py-10">
                <QrCode className="text-muted-foreground size-8" aria-hidden />
                <p className="text-sm">Add your UPI id to show a payment QR.</p>
                {can('agent.settings.manage') ? (
                  <Button asChild>
                    <Link href="/agent/settings">
                      <Settings /> Shop settings
                    </Link>
                  </Button>
                ) : (
                  <p className="text-muted-foreground text-xs">Ask the shop owner to add it.</p>
                )}
              </div>
            )}
          </section>
          <section className="bg-card flex flex-col items-center gap-3 rounded-xl border p-5 text-center">
            <h2 className="self-start text-base font-semibold">Bank QR</h2>
            {p.has_qr_image ? (
              bankQr ? (
                // eslint-disable-next-line @next/next/no-img-element -- private image from the API as an object URL
                <img src={bankQr} alt="The shop's bank QR code" className="max-h-96 w-auto rounded-lg border bg-white p-2" />
              ) : (
                <Skeleton className="size-72" />
              )
            ) : (
              <p className="text-muted-foreground py-10 text-sm">
                No bank QR uploaded.{' '}
                {can('agent.settings.manage') && (
                  <Link href="/agent/settings" className="text-primary hover:underline">
                    Upload one
                  </Link>
                )}
              </p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
