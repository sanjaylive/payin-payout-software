'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export interface MerchantOption {
  id: string;
  name: string;
}

/** Merchant picker for platform/reseller views. Options must come from a tenant-scoped API call. */
export function MerchantSelector({
  merchants,
  value,
  onChange,
  allowAll = true,
  className,
}: {
  merchants: MerchantOption[];
  value: string | null;
  onChange: (merchantId: string | null) => void;
  allowAll?: boolean;
  className?: string;
}) {
  return (
    <Select value={value ?? '__all__'} onValueChange={(v) => onChange(v === '__all__' ? null : v)}>
      <SelectTrigger className={className ?? 'w-56'} aria-label="Merchant">
        <SelectValue placeholder="Select merchant" />
      </SelectTrigger>
      <SelectContent>
        {allowAll && <SelectItem value="__all__">All merchants</SelectItem>}
        {merchants.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
