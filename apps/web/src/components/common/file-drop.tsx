'use client';

import { cn } from '@pay2all/ui/lib/utils';
import { FileText, UploadCloud, X } from 'lucide-react';
import { type DragEvent, useId, useState } from 'react';

/** Drag-and-drop (or click to browse) for one file. Type and size are checked again by the server. */
export function FileDrop({ file, onFile, accept, hint }: { file: File | null; onFile: (f: File | null) => void; accept: string; hint?: string }) {
  const id = useId();
  const [over, setOver] = useState(false);
  function drop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  }
  if (file) {
    return (
      <div className="bg-muted/40 flex items-center gap-3 rounded-lg border p-3">
        <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-md"><FileText className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.name}</p>
          <p className="text-muted-foreground text-xs">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
        </div>
        <button type="button" className="text-muted-foreground hover:text-foreground rounded p-1" onClick={() => onFile(null)} aria-label="Remove file"><X className="size-4" /></button>
      </div>
    );
  }
  return (
    <label
      htmlFor={id}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cn(
        'hover:border-primary/60 hover:bg-primary/5 flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors',
        over && 'border-primary bg-primary/5',
      )}
    >
      <UploadCloud className="text-primary size-7" />
      <span className="text-sm"><span className="text-primary font-medium">Click to choose a file</span> or drag it here</span>
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
      <input id={id} type="file" accept={accept} className="sr-only" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
    </label>
  );
}
