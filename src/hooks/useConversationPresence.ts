'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase-client'

/**
 * One agent currently looking at (or composing in) a conversation.
 *
 * `online_at` is set the moment the user joins the channel and never moves —
 * it's just there so the UI can render "viewing for 30s ago" if it ever wants
 * to. `composing` flips true while the agent is actively typing in the reply
 * box and auto-clears after 5s of silence.
 */
export interface PresentUser {
  user_id: string
  display_name: string
  avatar_url?: string | null
  online_at: string
  composing: boolean
}

interface PresenceOpts {
  user_id: string
  display_name: string
  avatar_url?: string | null
}

interface PresenceResult {
  others: PresentUser[]
  setComposing: (composing: boolean) => void
}

/**
 * Subscribes to a Supabase Realtime presence channel scoped to one
 * conversation so multiple agents can see each other in real time.
 *
 * Channel name is intentionally distinct from `conversation-${id}` (used by
 * `ConversationRealtime` for postgres_changes) so the two subscriptions don't
 * collide.
 *
 * Self-filtering: we use `opts.user_id` as the presence key, so two browser
 * tabs from the same agent share the same key and Supabase merges them into a
 * single presence entry — the user never sees themselves in `others`.
 */
export function useConversationPresence(
  conversationId: string,
  opts: PresenceOpts
): PresenceResult {
  const [others, setOthers] = useState<PresentUser[]>([])

  // Hold the live channel in a ref so callbacks (debounced setComposing) can
  // call .track() without re-running the subscription effect.
  const channelRef = useRef<RealtimeChannel | null>(null)
  const composingRef = useRef<boolean>(false)
  const composingDebounceRef = useRef<NodeJS.Timeout | null>(null)
  const composingClearRef = useRef<NodeJS.Timeout | null>(null)
  const onlineAtRef = useRef<string>(new Date().toISOString())

  // Re-track on the channel with the latest composing flag. Bails if the
  // channel hasn't subscribed yet (e.g. setComposing called before mount
  // finished).
  const trackState = useCallback(
    async (composing: boolean) => {
      const ch = channelRef.current
      if (!ch) return
      composingRef.current = composing
      try {
        await ch.track({
          user_id: opts.user_id,
          display_name: opts.display_name,
          avatar_url: opts.avatar_url ?? null,
          online_at: onlineAtRef.current,
          composing,
        })
      } catch {
        /* presence updates are best-effort — never let them throw */
      }
    },
    [opts.user_id, opts.display_name, opts.avatar_url]
  )

  useEffect(() => {
    if (!conversationId || !opts.user_id) return

    const supabase = createClient()
    const channel = supabase.channel(`conversation-presence:${conversationId}`, {
      config: { presence: { key: opts.user_id } },
    })

    // Whenever ANY presence event fires, recompute the full snapshot from
    // channel.presenceState() — simpler than diffing join/leave manually and
    // matches what the user actually wants ("who is here right now").
    const syncOthers = () => {
      const state = channel.presenceState() as Record<string, Array<Partial<PresentUser>>>
      const seen = new Map<string, PresentUser>()
      for (const [key, metas] of Object.entries(state)) {
        // The user's own presence key is opts.user_id — skip it so we don't
        // ever render ourselves as "another agent". Two tabs from the same
        // agent share this key, so they collapse to one entry that we skip.
        if (key === opts.user_id) continue
        // A single key can have multiple metas (e.g. user opened the same
        // conversation in two tabs on a different account). Pick the last
        // one — it has the freshest composing flag.
        const last = metas[metas.length - 1]
        if (!last || !last.user_id) continue
        seen.set(last.user_id, {
          user_id: last.user_id,
          display_name: last.display_name || 'Agent',
          avatar_url: last.avatar_url ?? null,
          online_at: last.online_at || new Date().toISOString(),
          composing: !!last.composing,
        })
      }
      setOthers(Array.from(seen.values()))
    }

    channel
      .on('presence', { event: 'sync' }, syncOthers)
      .on('presence', { event: 'join' }, syncOthers)
      .on('presence', { event: 'leave' }, syncOthers)
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          channelRef.current = channel
          await channel.track({
            user_id: opts.user_id,
            display_name: opts.display_name,
            avatar_url: opts.avatar_url ?? null,
            online_at: onlineAtRef.current,
            composing: false,
          })
        }
      })

    return () => {
      if (composingDebounceRef.current) clearTimeout(composingDebounceRef.current)
      if (composingClearRef.current) clearTimeout(composingClearRef.current)
      // Untrack first so peers see us leave before the channel goes away.
      void channel.untrack().catch(() => { /* ignore */ })
      void supabase.removeChannel(channel)
      channelRef.current = null
    }
  }, [conversationId, opts.user_id, opts.display_name, opts.avatar_url])

  /**
   * Public API: notify the channel that this user started or stopped typing.
   *
   *  - `true`  — debounced 200ms so a single keystroke doesn't fire a track
   *              call; once the debounce settles we publish composing=true
   *              and arm a 5s timer that auto-clears it.
   *  - `false` — published immediately and cancels any pending timers.
   */
  const setComposing = useCallback(
    (composing: boolean) => {
      if (composingDebounceRef.current) {
        clearTimeout(composingDebounceRef.current)
        composingDebounceRef.current = null
      }
      if (composingClearRef.current) {
        clearTimeout(composingClearRef.current)
        composingClearRef.current = null
      }

      if (composing) {
        composingDebounceRef.current = setTimeout(() => {
          void trackState(true)
          // Auto-clear after 5s of inactivity. The textarea handler will
          // call setComposing(true) again on every keystroke, which resets
          // this timer (because we cleared it above on entry).
          composingClearRef.current = setTimeout(() => {
            void trackState(false)
          }, 5000)
        }, 200)
      } else {
        // Only publish a flip if we were actually composing — avoids an
        // unnecessary track() round-trip on every cleanup.
        if (composingRef.current) {
          void trackState(false)
        }
      }
    },
    [trackState]
  )

  return { others, setComposing }
}
