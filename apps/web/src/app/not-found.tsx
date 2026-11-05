import { EmptyState } from '@pay2all/ui/components/states';
import { Button } from '@pay2all/ui/components/ui/button';
import { SearchX } from 'lucide-react';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <EmptyState icon={SearchX} title="Page not found" description="The page you're looking for doesn't exist." action={<Button asChild><Link href="/home">Go home</Link></Button>} />
    </div>
  );
}
