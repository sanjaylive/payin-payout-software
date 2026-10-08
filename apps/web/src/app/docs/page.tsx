import type { Metadata } from 'next';
import { DocsShell } from '@/features/docs/docs-shell';

export const metadata: Metadata = { title: 'API reference', description: 'Accept payments, send payouts and receive webhooks from your server.' };

/** Public developer documentation — no sign-in needed. */
export default function DocsPage() {
  return <DocsShell />;
}
