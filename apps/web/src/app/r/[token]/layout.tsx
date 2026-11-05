import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/** A customer's receipt link: no sign-in, never indexed. */
export const metadata: Metadata = {
  title: 'Receipt',
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: 'no-referrer',
};

export default function PublicReceiptLayout({ children }: { children: ReactNode }) {
  return children;
}
