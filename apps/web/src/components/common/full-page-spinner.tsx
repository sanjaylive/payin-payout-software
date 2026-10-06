import { Loader2 } from 'lucide-react';

export function FullPageSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center" aria-busy="true" aria-label="Loading">
      <Loader2 className="text-primary size-6 animate-spin" />
    </div>
  );
}
