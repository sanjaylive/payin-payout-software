import type { MetadataRoute } from 'next';
import { currentSite } from '@/features/landing/site';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { origin, variant, brand } = await currentSite();
  const lastModified = brand.updated_at ? new Date(brand.updated_at) : new Date();
  return [
    { url: `${origin}/`, lastModified, changeFrequency: 'weekly', priority: 1 },
    ...(variant === 'PAYMENTS' ? [{ url: `${origin}/docs`, lastModified, changeFrequency: 'weekly' as const, priority: 0.8 }] : []),
  ];
}
