'use client'

import { useEffect, useRef } from 'react'

/**
 * Fires /api/inbox-sync on a timer so new email/Teams messages land in the
 * portal without the user having to hit Sync manually.
 *
 * - Runs only while the tab is VISIBLE (document.visibilityState === 'visible')
 *   so a backgrounded tab doesn't burn Gmail IMAP quota.
 * - Fires once immediately on mount, then every POLL_INTERVAL_MS.
 * - Respects the server-side 20s throttle + "already running" guard, so
 *   multiple tabs or a refresh won't double-poll Gmail.
 *
 * Mounted at the dashboard layout level so it runs on any authenticated page.
 */
const POLL_INTERVAL_MS = 120_000 // 2 minutes

export function BackgroundPoller() {
  const inFlight = useRef(false)

  useEffect(() => {
    let cancelled = false

    const fire = async () => {
      if (cancelled) return
      if (inFlight.current) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      inFlight.current = true
      try {
        await fetch('/api/inbox-sync', { method: 'POST' }).catch(() => {})
      } finally {
        inFlight.current = false
      }
    }

    // Fire once on mount
    fire()

    // Regular interval
    const intervalId = setInterval(fire, POLL_INTERVAL_MS)

    // Re-fire whenever the tab becomes visible again (e.g. user switches back)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fire()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return null
}
