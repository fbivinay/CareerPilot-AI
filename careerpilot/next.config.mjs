/** @type {import('next').NextConfig} */
export default {
  // Native libSQL bindings must stay external to the server bundle.
  serverExternalPackages: ['@libsql/client', 'libsql'],
  poweredByHeader: false,
  turbopack: { root: import.meta.dirname },
  agentRules: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      ],
    }];
  },
};
