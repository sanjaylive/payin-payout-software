import type { MetadataRoute } from 'next';
import { currentSite } from '@/features/landing/site';

/** Public pages are open to search engines and AI crawlers; dashboards and customer links are not. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const { origin, variant } = await currentSite();
  const disallow = ['/admin', '/agent', '/dashboard', '/reseller', '/partner', '/onboarding', '/settings', '/home', '/checkout', '/r/', '/p/', '/setup-mfa', '/reset-password', '/forgot-password'];
  const allow = ['/', '/llms.txt', '/signup', '/login', ...(variant === 'PAYMENTS' ? ['/docs'] : [])];
  return {
    rules: [
      { userAgent: '*', allow, disallow },
      // AI assistants: same rules, named explicitly so they're welcome to cite the public pages.
      { userAgent: ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'Bingbot'], allow, disallow },
    ],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
