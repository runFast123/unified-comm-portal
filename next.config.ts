import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  serverExternalPackages: ['jspdf', 'jspdf-autotable'],
}

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  tunnelRoute: '/monitoring', // proxies Sentry through our domain to bypass ad blockers
  sourcemaps: { disable: true }, // don't ship source maps publicly (was hideSourceMaps in older versions)
  disableLogger: true,
})
