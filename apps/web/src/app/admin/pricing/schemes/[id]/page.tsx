'use client';

import { useParams } from 'next/navigation';
import { SchemeEditor } from '@/features/schemes/scheme-editor';

export default function SchemePage() {
  const { id } = useParams<{ id: string }>();
  return <SchemeEditor schemeId={id} />;
}
