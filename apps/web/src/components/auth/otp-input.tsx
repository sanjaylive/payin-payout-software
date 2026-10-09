'use client';

import { cn } from '@pay2all/ui/lib/utils';
import { type ClipboardEvent, type KeyboardEvent, useRef } from 'react';

/** Six single-digit boxes: type, backspace and paste the whole code. Calls onComplete once all are filled. */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
  invalid,
  length = 6,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  length?: number;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');

  function set(next: string, focus: number) {
    const clean = next.replace(/\D/g, '').slice(0, length);
    onChange(clean);
    refs.current[Math.min(focus, length - 1)]?.focus();
    if (clean.length === length) onComplete?.(clean);
  }

  function onKey(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[i]) set(value.slice(0, i) + value.slice(i + 1), i);
      else if (i > 0) set(value.slice(0, i - 1) + value.slice(i), i - 1);
    } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && i < length - 1) refs.current[i + 1]?.focus();
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (pasted) set(pasted, pasted.length);
  }

  return (
    <div className="flex justify-between gap-2" role="group" aria-label="Verification code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          autoFocus={i === 0}
          aria-label={`Digit ${i + 1}`}
          aria-invalid={invalid}
          maxLength={length}
          onKeyDown={(e) => onKey(i, e)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const typed = e.target.value.replace(/\D/g, '');
            if (!typed) return;
            // Autofill can drop the whole code into one box.
            if (typed.length > 1) set(value.slice(0, i) + typed, i + typed.length);
            else set(value.slice(0, i) + typed + value.slice(i + 1), i + 1);
          }}
          className={cn(
            'bg-background size-12 rounded-lg border text-center font-mono text-xl font-semibold tabular-nums shadow-xs transition outline-none sm:size-13',
            'focus:border-primary focus:ring-primary/20 focus:ring-4',
            d && 'border-primary/50',
            invalid && 'border-destructive focus:border-destructive focus:ring-destructive/20',
            disabled && 'opacity-60',
          )}
        />
      ))}
    </div>
  );
}
