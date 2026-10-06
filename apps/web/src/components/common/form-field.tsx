import { Input } from '@pay2all/ui/components/ui/input';
import { Label } from '@pay2all/ui/components/ui/label';
import { type ComponentProps, forwardRef } from 'react';

type FormFieldProps = ComponentProps<typeof Input> & { label: string; error?: string; hint?: string };

/** Label + input + error message wired for accessibility (aria-invalid / aria-describedby). */
export const FormField = forwardRef<HTMLInputElement, FormFieldProps>(function FormField({ label, error, hint, id, ...props }, ref) {
  const fieldId = id ?? props.name;
  const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <Input ref={ref} id={fieldId} aria-invalid={Boolean(error)} aria-describedby={describedBy} {...props} />
      {error ? (
        <p id={`${fieldId}-error`} className="text-destructive text-xs">{error}</p>
      ) : hint ? (
        <p id={`${fieldId}-hint`} className="text-muted-foreground text-xs">{hint}</p>
      ) : null}
    </div>
  );
});
