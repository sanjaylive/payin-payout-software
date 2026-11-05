import { StatusBadge } from '@pay2all/ui/components/status-badge';
import { cn } from '@pay2all/ui/lib/utils';
import type { ReactNode } from 'react';
import { API_URL } from '@/lib/api/client';
import { type AgentReceipt, fmtMobile, inr, istDateTime, MODE_LABEL, STATUS_LABEL } from './api';

function Row({ label, value, strong, mono }: { label: string; value: ReactNode; strong?: boolean; mono?: boolean }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground shrink-0 print:text-black/60">{label}</dt>
      <dd className={cn('text-right break-all', strong && 'text-base font-semibold', mono && 'font-mono text-xs leading-5')}>{value}</dd>
    </div>
  );
}

/**
 * One receipt, for the agent's printable page and the customer's public link (/r/<token>). Logo and
 * footer appear only on branded plans; otherwise "Powered by …".
 */
export function ReceiptView({ receipt, className }: { receipt: AgentReceipt; className?: string }) {
  const t = receipt.transaction;
  const s = receipt.shop;
  const tone = t.status === 'SUCCESS' ? 'success' : t.status === 'PENDING' ? 'warning' : t.status === 'FAILED' ? 'danger' : 'neutral';
  return (
    <article
      className={cn(
        'bg-card mx-auto w-full max-w-md rounded-2xl border p-6 text-sm shadow-sm print:max-w-none print:rounded-none print:border-0 print:bg-white print:p-0 print:text-black print:shadow-none',
        className,
      )}
      aria-label={`Receipt ${t.receipt_no}`}
    >
      <header className="flex items-start gap-3 border-b pb-4 print:border-black/20">
        {s.logo_url && (
          // eslint-disable-next-line @next/next/no-img-element -- served by the API, not an optimisable asset
          <img src={`${API_URL}${s.logo_url}`} alt="" className="size-14 shrink-0 rounded-lg border bg-white object-contain p-1" />
        )}
        <div className="min-w-0">
          <h2 className="text-lg leading-tight font-semibold">{s.name}</h2>
          {s.address && <p className="text-muted-foreground mt-0.5 text-xs print:text-black/70">{s.address}</p>}
          <p className="text-muted-foreground text-xs print:text-black/70">Phone {fmtMobile(s.mobile)}</p>
        </div>
      </header>

      <div className="flex items-center justify-between gap-3 py-4">
        <div>
          <p className="text-base font-semibold">{receipt.type_label}</p>
          <p className="text-muted-foreground text-xs print:text-black/70">
            Receipt <span className="font-mono">{t.receipt_no}</span> · {istDateTime(t.occurred_at)}
          </p>
        </div>
        <StatusBadge status={STATUS_LABEL[t.status]} tone={tone} className="print:ring-black/30" />
      </div>

      <div className="bg-muted/50 rounded-xl px-4 py-3 text-center print:border print:border-black/20 print:bg-white">
        <p className="text-muted-foreground text-xs print:text-black/70">{t.direction === 'IN' ? 'Total paid by customer' : 'Cash paid to customer'}</p>
        <p className="mt-0.5 text-3xl font-semibold tracking-tight tabular-nums">{inr(t.total)}</p>
      </div>

      <dl className="mt-4 divide-y print:divide-black/15">
        {t.customer && (
          <div className="py-1">
            <Row label="Customer" value={t.customer.name} />
            <Row label="Mobile" value={t.customer.mobile ? fmtMobile(t.customer.mobile) : null} />
          </div>
        )}
        {t.beneficiary && (
          <div className="py-1">
            <Row label="Beneficiary" value={t.beneficiary.name} />
            <Row label="Bank" value={t.beneficiary.bank_name} />
            <Row label="Account" value={t.beneficiary.account_masked} mono />
            <Row label="IFSC" value={t.beneficiary.ifsc} mono />
            <Row label="UPI" value={t.beneficiary.upi_id} />
          </div>
        )}
        <div className="py-1">
          <Row label="Amount" value={inr(t.amount)} />
          <Row label="Service charge" value={inr(t.fee)} />
          <Row label={t.direction === 'IN' ? 'Total' : 'Paid out'} value={inr(t.total)} strong />
        </div>
        <div className="py-1">
          <Row label="Paid by" value={MODE_LABEL[t.mode]} />
          <Row label="Reference (UTR/RRN)" value={t.reference} mono />
          <Row label="Note" value={t.description} />
          {t.status_note && <Row label="Status note" value={t.status_note} />}
        </div>
      </dl>

      <footer className="text-muted-foreground mt-4 space-y-1 border-t pt-4 text-center text-xs print:border-black/20 print:text-black/70">
        {s.footer && <p className="text-foreground print:text-black">{s.footer}</p>}
        <p>This is a record of a transaction made at this shop. Keep it for your reference.</p>
        {receipt.powered_by && <p>Powered by {receipt.powered_by}</p>}
      </footer>
    </article>
  );
}
