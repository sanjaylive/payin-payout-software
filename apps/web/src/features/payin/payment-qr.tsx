'use client';

import { Skeleton } from '@pay2all/ui/components/ui/skeleton';
import { toDataURL } from 'qrcode';
import { useEffect, useState } from 'react';

/** Renders a UPI payload as a QR image locally — the payload never leaves the browser. */
export function PaymentQr({ payload, size = 220 }: { payload: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void toDataURL(payload, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' }).then((url) => !cancelled && setSrc(url));
    return () => {
      cancelled = true;
    };
  }, [payload, size]);
  if (!src) return <Skeleton style={{ width: size, height: size }} />;
  // eslint-disable-next-line @next/next/no-img-element -- local data URL, not an optimisable asset
  return <img src={src} width={size} height={size} alt="UPI QR code for this payment" className="rounded-lg border bg-white p-2" />;
}
