import { currentSite, llmsText } from '@/features/landing/site';

/** https://llmstxt.org — a plain-Markdown summary for AI assistants, following the live landing page. */
export async function GET() {
  return new Response(llmsText(await currentSite()), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
