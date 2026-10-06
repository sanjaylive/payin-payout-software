'use client';

import { CalendarDays } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Calendar } from './ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export type DatePreset = 'today' | 'yesterday' | '7d' | '30d' | 'custom';
export interface DateRangeValue {
  preset: DatePreset;
  /** Inclusive start, exclusive end — both UTC instants derived from the viewer's local days. */
  from: Date;
  to: Date;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function presetRange(preset: Exclude<DatePreset, 'custom'>, now = new Date()): DateRangeValue {
  const today = startOfLocalDay(now);
  const day = 86_400_000;
  switch (preset) {
    case 'today':
      return { preset, from: today, to: new Date(today.getTime() + day) };
    case 'yesterday':
      return { preset, from: new Date(today.getTime() - day), to: today };
    case '7d':
      return { preset, from: new Date(today.getTime() - 6 * day), to: new Date(today.getTime() + day) };
    case '30d':
      return { preset, from: new Date(today.getTime() - 29 * day), to: new Date(today.getTime() + day) };
  }
}

const PRESETS: { id: Exclude<DatePreset, 'custom'>; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

export function DateRangeFilter({ value, onChange }: { value: DateRangeValue; onChange: (v: DateRangeValue) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-muted inline-flex items-center gap-1 rounded-lg p-1">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onChange(presetRange(p.id))}
          className={cn(
            'rounded-md px-3 py-1 text-sm font-medium transition-colors',
            value.preset === p.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {p.label}
        </button>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant={value.preset === 'custom' ? 'secondary' : 'ghost'} size="sm" className="h-7">
            <CalendarDays /> Custom
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={{ from: value.from, to: new Date(value.to.getTime() - 1) }}
            onSelect={(range) => {
              if (range?.from && range.to) {
                onChange({ preset: 'custom', from: startOfLocalDay(range.from), to: new Date(startOfLocalDay(range.to).getTime() + 86_400_000) });
                setOpen(false);
              }
            }}
            disabled={{ after: new Date() }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
