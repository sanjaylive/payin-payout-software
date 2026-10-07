import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Shared design system ships TypeScript source.
  transpilePackages: ['@pay2all/ui'],
  async headers() {
    // CSP is set per request (with a nonce) in src/proxy.ts; these apply to every response.
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // geolocation=(self): the sign-in page may ask for the device location (login history). Never third parties.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self), payment=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
