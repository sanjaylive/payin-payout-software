import { CheckCircle2 } from 'lucide-react';

export const metadata = { title: 'Payment' };

/** Where a gateway payment made outside hosted checkout lands. The merchant confirms the outcome via its API. */
export default function PaymentReturnPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="bg-card max-w-md rounded-2xl border p-8 text-center shadow-sm">
        <CheckCircle2 className="text-primary mx-auto size-10" />
        <h1 className="mt-3 text-xl font-semibold">Thanks — we’re confirming your payment</h1>
        <p className="text-muted-foreground mt-2 text-sm">You can close this window. The merchant will let you know once the payment is confirmed.</p>
      </div>
    </div>
  );
}
